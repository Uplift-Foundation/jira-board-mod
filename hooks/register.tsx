// jira-board: a live Jira board in a pane beside the chat.
//
// Jira is read through the session's own connected Atlassian MCP server
// (`$.mcp.call`), so the mod holds no token of its own and sees exactly what
// the person's Atlassian login sees. Nothing is fetched while the pane is
// closed: the refresh timer checks the pane is placed before it calls out,
// which matters on a machine running a couple of dozen sessions at once.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Board, Fetch, Moves, View } from '../types'
import {
  buildJql,
  describeResult,
  mcpErrorText,
  mcpJson,
  mcpJsonCandidates,
  parseSearch,
  parseTransitions,
  spilledPath,
} from './board'
import { renderPane } from './view'

const PANE = 'jira-board'
const SEARCH_TOOL = 'searchJiraIssuesUsingJql'
const FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'updated']
// Three pages of a hundred: a board bigger than that is not read on a phone.
const MAX_PAGES = 3

const boardAtom = atom({ plugin: 'jira-board', key: 'board' } as const, null, { shape: 'board-1' })
const fetchAtom = atom({ plugin: 'jira-board', key: 'fetch' } as const, { isLoading: false } as Fetch, {
  shape: 'fetch-1',
})
const viewAtom = atom({ plugin: 'jira-board', key: 'view' } as const, { isMine: false } as View, {
  shape: 'view-1',
})
const movesAtom = atom({ plugin: 'jira-board', key: 'moves' } as const, null, { shape: 'moves-2' })

type Config = {
  site: string
  project: string
  boardId: string
  columns: string
  doneDays: number
  jql: string
  refreshSeconds: number
  openOnStart: boolean
  mcpServer: string
}

function config(options: PluginOptions): Config {
  const s = (name: string, fallback: string) => {
    const v = options[name]
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback
  }
  const n = (name: string, fallback: number) => {
    const v = options[name]
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback
  }
  return {
    site: s('site', '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    project: s('project', '').toUpperCase(),
    boardId: s('boardId', ''),
    columns: s('columns', ''),
    doneDays: n('doneDays', 14),
    jql: s('jql', ''),
    refreshSeconds: Math.max(15, n('refreshSeconds', 60)),
    openOnStart: options.openOnStart === true,
    mcpServer: s('mcpServer', ''),
  }
}

// Kept in the module: a reload starts them over, which costs one lookup.
let server: string | undefined
// The fetch under way, so a refresh asked for meanwhile waits for it rather
// than starting a second one or answering without an outcome.
let running: Promise<string> | undefined

// The Atlassian server as the session connected it: the one named in the
// settings, else whichever connected server offers the Jira search tool.
async function findServer($: EngineInterface, cfg: Config): Promise<string> {
  if (cfg.mcpServer) return cfg.mcpServer
  if (server) return server
  const pattern = new RegExp(`^mcp__(.+)__${SEARCH_TOOL}$`)
  for (const tool of await $.tool.list()) {
    const match = pattern.exec(tool.name)
    if (match?.[1]) return (server = match[1])
  }
  throw new Error(
    'No Atlassian MCP server is connected. Connect one with /mcp, or name it in /config → jira-board → Atlassian MCP server.',
  )
}

// What the pane says until the two settings it cannot guess are filled in.
const SETUP = 'Set your Jira site and project key in /config → jira-board, then press Refresh.'

// The board's name where a title or a line needs one before a project is set.
function label(cfg: Config): string {
  return cfg.project || 'Jira'
}

async function callRaw($: EngineInterface, cfg: Config, tool: string, args: Record<string, unknown>) {
  if (!cfg.site || !cfg.project) throw new Error(SETUP)
  const result = await $.mcp.call(await findServer($, cfg), tool, { cloudId: cfg.site, ...args })
  if (result.isError) throw new Error(mcpErrorText(result))
  return result
}

async function call($: EngineInterface, cfg: Config, tool: string, args: Record<string, unknown>) {
  return mcpJson(await callRaw($, cfg, tool, args))
}

// A search, read from whichever part of the reply holds the issues. A reply
// with none is an error naming what did come back, never an empty board: an
// empty board says "no issues", which is a claim about Jira, not the reply.
async function search($: EngineInterface, cfg: Config, args: Record<string, unknown>) {
  const result = await callRaw($, cfg, SEARCH_TOOL, args)
  for (const json of mcpJsonCandidates(result)) {
    const parsed = parseSearch(json)
    if (parsed.isSearch) return parsed
  }
  const spilled = spilledPath(result)
  if (spilled) {
    const parsed = parseSearch(JSON.parse(await $.fs.read(spilled)))
    if (parsed.isSearch) return parsed
  }
  throw new Error(`Jira answered, but not with a list of issues (${describeResult(result)})`)
}

// Answers what happened in a line: what `/jira refresh` prints, and the
// debug log's record of every fetch.
async function refresh($: EngineInterface, cfg: Config): Promise<string> {
  running ??= fetchBoard($, cfg).finally(() => {
    running = undefined
  })
  return running
}

async function fetchBoard($: EngineInterface, cfg: Config): Promise<string> {
  await update($, fetchAtom, f => ({ ...f, isLoading: true }))
  try {
    const view = await read($, viewAtom)
    const jql = buildJql({
      project: cfg.project,
      doneDays: cfg.doneDays,
      isMine: view.isMine,
      extra: cfg.jql,
    })
    const cards: Board['cards'] = []
    let token: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const parsed = await search($, cfg, {
        jql,
        fields: FIELDS,
        maxResults: 100,
        responseContentFormat: 'markdown',
        ...(token ? { nextPageToken: token } : {}),
      })
      cards.push(...parsed.cards)
      token = parsed.next
      if (!token) break
    }
    const fetchedAt = await $.clock.now()
    await update($, boardAtom, () => ({
      site: cfg.site,
      project: cfg.project,
      boardId: cfg.boardId,
      cards,
      fetchedAt,
    }))
    await update($, fetchAtom, () => ({ isLoading: false }))
    const outcome = `Loaded ${cards.length} ${label(cfg)} issue${cards.length === 1 ? '' : 's'}.`
    $.ui.log(`jira-board: ${outcome}`, { to: 'debug' })
    return outcome
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, fetchAtom, () => ({ isLoading: false, error }))
    $.ui.log(`jira-board: refresh failed: ${error}`, { to: 'debug' })
    return `Jira refresh failed: ${error}`
  }
}

async function openIssue($: EngineInterface, cfg: Config, key: string) {
  await update($, viewAtom, v => ({ ...v, selected: key }))
  await update($, movesAtom, () => ({ key, list: [], isLoading: true }))
  try {
    const board = await read($, boardAtom)
    let card = board?.cards.find(c => c.key === key)
    if (!card) {
      card = (await search($, cfg, { jql: `key = ${key}`, fields: FIELDS, maxResults: 1 })).cards[0]
    }
    const list = parseTransitions(
      await call($, cfg, 'getTransitionsForJiraIssue', { issueIdOrKey: key }),
    )
    await update($, movesAtom, m => (m?.key === key ? { key, list, isLoading: false, card } : m))
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, movesAtom, m => (m?.key === key ? { ...m, isLoading: false, error } : m))
  }
}

async function move($: EngineInterface, cfg: Config, key: string, transitionId: string, to: string) {
  try {
    await call($, cfg, 'transitionJiraIssue', { issueIdOrKey: key, transition: { id: transitionId } })
    // Show the move at once; the refresh below brings the real status back.
    await update($, boardAtom, b =>
      b ? { ...b, cards: b.cards.map(c => (c.key === key ? { ...c, status: to } : c)) } : b,
    )
    $.ui.toast(`${key} → ${to}`)
    await refresh($, cfg)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, movesAtom, m => (m?.key === key ? { ...m, error } : m))
  }
}

async function openBoard($: EngineInterface, cfg: Config, focus: boolean) {
  const opened = await $.ui.open({
    id: PANE,
    title: `${label(cfg)} board`,
    ...(focus ? { focus: true as const } : {}),
  })
  const board = await read($, boardAtom)
  const now = await $.clock.now()
  const stale = !board || now - board.fetchedAt > (cfg.refreshSeconds * 1000) / 2
  if (opened.isPlaced && stale) void refresh($, cfg)
  return opened
}

export const register: Register = (on, options) => {
  const cfg = config(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jira',
      description: `Show the ${label(cfg)} board in a pane`,
      argumentHint: '[refresh | mine | all | close | ISSUE-KEY]',
    })
    if (cfg.openOnStart) void openBoard($, cfg, false)
    $.clock.every(cfg.refreshSeconds * 1000, async () => {
      const pane = (await $.ui.panes()).find(p => p.id === PANE)
      if (pane?.isPlaced) await refresh($, cfg)
    })
    return next(e)
  })

  on('command.run', { command: 'jira' }, async ($, e) => {
    const arg = e.args.trim()
    const word = arg.toLowerCase()

    if (word === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Jira board closed.' }
    }
    if (word === 'mine' || word === 'all') {
      await update($, viewAtom, v => ({ ...v, isMine: word === 'mine', selected: undefined }))
      await openBoard($, cfg, true)
      void refresh($, cfg)
      return { text: word === 'mine' ? 'Showing issues assigned to you.' : 'Showing every issue.' }
    }
    if (/^[a-z][a-z0-9_]*-\d+$/i.test(arg)) {
      const key = arg.toUpperCase()
      await openBoard($, cfg, true)
      void openIssue($, cfg, key)
      return { text: `Opened ${key}.` }
    }
    await update($, viewAtom, v => ({ ...v, selected: undefined }))
    const opened = await openBoard($, cfg, true)
    const where = opened.isPlaced
      ? `${label(cfg)} board open.`
      : `The ${label(cfg)} board is waiting for room: ${opened.reason}`
    // A refresh asked for by name is waited for, so its outcome is the answer.
    return { text: word === 'refresh' ? `${where} ${await refresh($, cfg)}` : where }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    return renderPane(
      ui,
      {
        site: cfg.site,
        project: label(cfg),
        isSetUp: Boolean(cfg.site && cfg.project),
        boardId: cfg.boardId,
        columnsSetting: cfg.columns,
        board: await read($, boardAtom),
        fetch: await read($, fetchAtom),
        view: await read($, viewAtom),
        moves: (await read($, movesAtom)) as Moves | null,
        bodyColumns: e.props.bodyColumns,
        isMobile: e.surface === 'mobile',
        now: await $.clock.now(),
      },
      {
        refresh: () => void refresh($, cfg),
        toggleMine: () => {
          void update($, viewAtom, v => ({ ...v, isMine: !v.isMine, selected: undefined })).then(
            () => refresh($, cfg),
          )
        },
        showColumn: name => void update($, viewAtom, v => ({ ...v, column: name })),
        open: key => void openIssue($, cfg, key),
        back: () => void update($, viewAtom, v => ({ ...v, selected: undefined })),
        move: (key, id, to) => void move($, cfg, key, id, to),
      },
    )
  })
}
