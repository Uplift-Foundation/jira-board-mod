import { expect, mock, test } from 'claude-code/testing'

import {
  buildJql,
  clip,
  describeResult,
  mcpJsonCandidates,
  groupColumns,
  initials,
  parseSearch,
  parseTransitions,
  sideBySide,
} from '../hooks/board'

// The shape the Atlassian MCP's searchJiraIssuesUsingJql answers, read off a
// real response: `issues.nodes`, each with `fields.status.statusCategory`.
function issue(key: string, status: [string, string, string], summary: string, extra = {}) {
  const [id, name, category] = status
  return {
    key,
    webUrl: `https://example.atlassian.net/browse/${key}`,
    fields: {
      summary,
      issuetype: { name: 'Bug' },
      priority: { name: 'High' },
      assignee: { displayName: 'Ada Lovelace' },
      updated: '2026-10-28T12:00:00.000-0700',
      status: { id, name, statusCategory: { key: category } },
      ...extra,
    },
  }
}

const REFINEMENT: [string, string, string] = ['10121', 'Refinement', 'new']
const DEVELOPMENT: [string, string, string] = ['10122', 'Development', 'indeterminate']
const TESTING: [string, string, string] = ['10123', 'Testing', 'indeterminate']
const DONE: [string, string, string] = ['10124', 'Done', 'done']

const SEARCH = {
  issues: {
    nodes: [
      issue('CB-4', DONE, 'Shipped thing'),
      issue('CB-3', TESTING, 'Being tested'),
      issue('CB-2', DEVELOPMENT, 'Being built'),
      issue('CB-1', REFINEMENT, 'An idea'),
      issue('CB-5', REFINEMENT, 'Another idea'),
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
}

const TRANSITIONS = {
  transitions: [
    { id: '11', name: 'Refinement', to: { name: 'Refinement' } },
    { id: '21', name: 'Development', to: { name: 'Development' } },
    { id: '31', name: 'Testing', to: { name: 'Testing' } },
    { id: '41', name: 'Done', to: { name: 'Done' } },
  ],
}

const text = (json: unknown) => ({
  value: { content: [{ type: 'text' as const, text: JSON.stringify(json) }], isError: false },
})

test('a search page parses into cards', async () => {
  const { cards, next } = parseSearch(SEARCH)
  expect(cards).toHaveLength(5)
  expect(next).toBeUndefined()
  expect(cards[1]).toEqual({
    key: 'CB-3',
    summary: 'Being tested',
    type: 'Bug',
    priority: 'High',
    assignee: 'Ada Lovelace',
    status: 'Testing',
    statusId: '10123',
    category: 'indeterminate',
    updated: '2026-10-28T12:00:00.000-0700',
    url: 'https://example.atlassian.net/browse/CB-3',
  })
  expect(parseSearch({ issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'abc' } } }).next).toBe('abc')
  expect(parseSearch(undefined).cards).toHaveLength(0)
  expect(parseSearch({ issues: { nodes: [{ key: 'X-1' }] } }).cards).toHaveLength(0)
})

test('columns go by category, then by status id', async () => {
  const columns = groupColumns(parseSearch(SEARCH).cards, [])
  expect(columns.map(c => c.name)).toEqual(['Refinement', 'Development', 'Testing', 'Done'])
  expect(columns[0]!.cards.map(c => c.key)).toEqual(['CB-1', 'CB-5'])
})

test('an explicit column list wins and keeps the statuses it leaves out', async () => {
  const columns = groupColumns(parseSearch(SEARCH).cards, ['done', 'Backlog', 'Refinement'])
  expect(columns.map(c => c.name)).toEqual(['Done', 'Backlog', 'Refinement', 'Development', 'Testing'])
  expect(columns[1]!.cards).toHaveLength(0)
})

test('the query', async () => {
  expect(buildJql({ project: 'CB', doneDays: 14, isMine: false, extra: '' })).toBe(
    'project = "CB" AND (statusCategory != Done OR updated >= -14d) ORDER BY Rank ASC',
  )
  expect(buildJql({ project: 'CB', doneDays: 0, isMine: true, extra: 'labels = ui' })).toBe(
    'project = "CB" AND statusCategory != Done AND assignee = currentUser() AND (labels = ui) ORDER BY Rank ASC',
  )
})

test('small forms', async () => {
  expect(initials('Ada Lovelace')).toBe('AL')
  expect(initials('cher')).toBe('CH')
  expect(initials(undefined)).toBe('—')
  expect(clip('abcdef', 4)).toBe('abc…')
  expect(clip('abc', 4)).toBe('abc')
  expect(sideBySide(160, 4)).toBe(true)
  expect(sideBySide(60, 4)).toBe(false)
  expect(parseTransitions(TRANSITIONS).map(t => t.to)).toEqual(['Refinement', 'Development', 'Testing', 'Done'])
})

// `/jira <args>` as the person types it at a fullscreen terminal.
function jira(args: string) {
  return {
    command: 'jira',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: true, columns: 160 },
  }
}

const OPTIONS = { options: { mcpServer: 'atlassian', site: 'example.atlassian.net', project: 'CB' } }

function pane(surface: 'terminal' | 'desktop' | 'mobile', bodyColumns: number) {
  return {
    plugin: 'jira-board',
    surface,
    component: 'Pane',
    requestId: 'jira-board',
    props: {
      title: 'CB board',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  } as const
}

test('the board loads and draws on every surface', OPTIONS, async ($, on) => {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  on('command.register', () => ({ value: { command: 'jira' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: Date.parse('2026-10-28T20:00:00Z') })
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: e.args })
    return text(e.tool === 'getTransitionsForJiraIssue' ? TRANSITIONS : SEARCH)
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(jira('refresh'))
  await clock.settle()

  const search = calls.find(c => c.tool === 'searchJiraIssuesUsingJql')
  expect(search?.args.cloudId).toBe('example.atlassian.net')
  expect(String(search?.args.jql)).toContain('project = "CB"')

  // Wide desktop: four bordered columns side by side.
  const desktop = await $.ui.mount(pane('desktop', 160))
  expect(await desktop.find({ key: 'col:Refinement' })).toBeDefined()
  expect(await desktop.find({ key: 'col:Done' })).toBeDefined()
  expect(await desktop.find({ key: 'tab:Refinement' })).toBeUndefined()
  expect((await desktop.find({ key: 'open:CB-2' }))?.text).toContain('Being built')
  await desktop.unmount()

  // A pane docked beside the terminal's transcript, and a phone: tabs.
  for (const [surface, width] of [['terminal', 50], ['mobile', 160]] as const) {
    const ui = await $.ui.mount(pane(surface, width))
    expect(await ui.find({ key: 'col:Refinement' })).toBeUndefined()
    expect(await ui.find({ key: 'tab:Testing' })).toBeDefined()
    // The first in-progress column with work in it is shown first; the tab
    // picked is the session's, so a surface drawn later keeps it.
    if (surface === 'terminal') expect(await ui.find({ key: 'open:CB-2' })).toBeDefined()
    else expect(await ui.find({ key: 'open:CB-1' })).toBeDefined()
    await ui.press({ key: 'tab:Development' })
    expect(await ui.find({ key: 'open:CB-2' })).toBeDefined()
    expect(await ui.find({ key: 'open:CB-1' })).toBeUndefined()
    await ui.press({ key: 'tab:Refinement' })
    expect(await ui.find({ key: 'open:CB-1' })).toBeDefined()
    await ui.unmount()
  }
})

test('a card opens its detail and moves it', OPTIONS, async ($, on) => {
  const moved: unknown[] = []
  on('command.register', () => ({ value: { command: 'jira' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: Date.parse('2026-10-28T20:00:00Z') })
  on('mcp.call', (_, e) => {
    if (e.tool === 'transitionJiraIssue') {
      moved.push(e.args)
      return text({})
    }
    return text(e.tool === 'getTransitionsForJiraIssue' ? TRANSITIONS : SEARCH)
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(jira(''))
  await clock.settle()

  const ui = await $.ui.mount(pane('desktop', 60))
  await ui.press({ key: 'tab:Testing' })
  await ui.press({ key: 'open:CB-3' })
  expect(await ui.find({ type: 'Text', text: /Being tested/ })).toBeDefined()
  // Its own status is not offered as a move.
  expect(await ui.find({ key: 'move:31' })).toBeUndefined()
  await ui.press({ key: 'move:41' })
  expect(moved).toEqual([{ cloudId: 'example.atlassian.net', issueIdOrKey: 'CB-3', transition: { id: '41' } }])
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'tab:Done' })).toBeDefined()
  await ui.unmount()
})

test('a server that refuses shows its words', OPTIONS, async ($, on) => {
  on('command.register', () => ({ value: { command: 'jira' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: Date.parse('2026-10-28T20:00:00Z') })
  on('mcp.call', () => ({ value: { content: [{ type: 'text' as const, text: 'Unauthorized' }], isError: true } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(jira('refresh'))
  await clock.settle()

  const ui = await $.ui.mount(pane('terminal', 80))
  expect((await ui.find({ type: 'Text', text: /Unauthorized/ }))?.text).toBe('Unauthorized')
  await ui.unmount()
})

test('issues are read from whichever part of the reply holds them', async () => {
  const reply = {
    structuredContent: { context: { toolName: 'search' } },
    content: [
      { type: 'text', text: JSON.stringify(SEARCH) },
      { type: 'text', text: 'Use jq to query this.' },
    ],
  }
  const found = mcpJsonCandidates(reply).map(parseSearch).find(p => p.isSearch)
  expect(found?.cards).toHaveLength(5)
  expect(describeResult({ content: [{ type: 'text', text: 'hello' }] })).toBe(
    'content: [text(5)]; starts: "hello"',
  )
})

test('a reply with no issues in it is an error, not an empty board', OPTIONS, async ($, on) => {
  on('command.register', () => ({ value: { command: 'jira' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: Date.parse('2026-10-28T20:00:00Z') })
  on('mcp.call', () => ({ value: { content: [{ type: 'text' as const, text: 'Rate limited' }], isError: false } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(jira('refresh'))
  await clock.settle()

  const ui = await $.ui.mount(pane('terminal', 80))
  expect((await ui.find({ type: 'Text', text: /not with a list of issues/ }))?.text).toContain('Rate limited')
  expect(await ui.find({ type: 'Text', text: /Nothing on the board/ })).toBeUndefined()
  await ui.unmount()
})

test('a reply past the size limit is read from the file it was saved to', OPTIONS, async ($, on) => {
  const SAVED = '/Users/someone/.claude/projects/p/s/tool-results/mcp-atlassian-searchJiraIssuesUsingJql-1.txt'
  const reads: string[] = []
  on('command.register', () => ({ value: { command: 'jira' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: Date.parse('2026-10-28T20:00:00Z') })
  // The note as Claude Code hands it over, in place of a result too large.
  on('mcp.call', () => ({
    value: {
      content: [
        {
          type: 'text' as const,
          text: `Error: result (65,407 characters) exceeds maximum allowed tokens. Output has been saved to ${SAVED}.\nFormat: JSON with schema: {issues: {nodes: [{...}]}}`,
        },
      ],
      isError: false,
    },
  }))
  on('fs.read', (_, e) => {
    reads.push(String(e.path))
    return { value: JSON.stringify(SEARCH) }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(jira('refresh'))
  await clock.settle()

  expect(reads).toEqual([SAVED])
  const ui = await $.ui.mount(pane('desktop', 160))
  expect(await ui.find({ key: 'open:CB-2' })).toBeDefined()
  await ui.unmount()
})

test('with no site or project set, the pane says how to set them and calls nothing', async ($, on) => {
  const calls: string[] = []
  on('command.register', () => ({ value: { command: 'jira' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on, { now: Date.parse('2026-10-28T20:00:00Z') })
  on('mcp.call', (_, e) => {
    calls.push(e.tool)
    return text(SEARCH)
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run(jira('refresh'))
  await clock.settle()

  expect(calls).toHaveLength(0)
  expect(ran.text).toContain('/config')
  const ui = await $.ui.mount({ ...pane('desktop', 160), props: { ...pane('desktop', 160).props, title: 'Jira board' } })
  expect((await ui.find({ type: 'Text', text: /\/config/ }))?.text).toContain('Jira site and project key')
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  await ui.unmount()
})
