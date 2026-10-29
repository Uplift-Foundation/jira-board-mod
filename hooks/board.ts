// The board's decisions, with no `$`, no drawing and no clock: what a search
// result says, which column an issue sits in, the order the columns go in,
// and the short forms a card wears. Kept pure so the tests can call it.

import type { Board, Card, Column, Transition } from '../types'

// Jira's three status categories, in the order a board reads left to right.
const CATEGORY_ORDER: Record<string, number> = { new: 0, indeterminate: 1, done: 2 }

const PRIORITY_GLYPH: Record<string, string> = {
  Highest: '⇈',
  High: '↑',
  Medium: '=',
  Low: '↓',
  Lowest: '⇊',
}

// Theme keys rather than raw colours, so the board follows the person's theme
// on every surface.
const TYPE_COLOR: Record<string, string> = {
  Bug: 'error',
  Feature: 'success',
  Story: 'success',
  Task: 'suggestion',
  Epic: 'merged',
  Subtask: 'subtle',
  'Sub-task': 'subtle',
}

const CATEGORY_COLOR: Record<string, string> = {
  new: 'subtle',
  indeterminate: 'warning',
  done: 'success',
}

type Json = Record<string, unknown>

function obj(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

type McpResult = { content: readonly unknown[]; structuredContent?: unknown }

// Every reading of an MCP result that could hold the tool's JSON, best first:
// the structured result a server with an output schema sends, each text block
// alone (a server may add a note in a block of its own after the JSON), then
// the text blocks joined (one long JSON split across several).
export function mcpJsonCandidates(result: McpResult): unknown[] {
  const out: unknown[] = []
  if (result.structuredContent !== undefined) out.push(result.structuredContent)
  const texts = result.content
    .map(block => str(obj(block)?.text))
    .filter((t): t is string => t !== undefined)
  for (const text of texts.length > 1 ? [...texts, texts.join('')] : texts) {
    try {
      out.push(JSON.parse(text))
    } catch {
      // Not JSON: a note, or one piece of a split body.
    }
  }
  return out
}

export function mcpJson(result: McpResult): unknown {
  return mcpJsonCandidates(result)[0]
}

// What came back, in a line, for an error that says the reply was not read:
// the blocks' kinds and lengths, the structured result's keys, and the start
// of the first text.
export function describeResult(result: McpResult): string {
  const blocks = result.content.map(block => {
    const b = obj(block)
    const text = str(b?.text)
    return text !== undefined ? `text(${text.length})` : String(b?.type ?? typeof block)
  })
  const structured = obj(result.structuredContent)
  const first = result.content.map(block => str(obj(block)?.text)).find(t => t !== undefined)
  const parts = [`content: [${blocks.join(', ')}]`]
  if (structured) parts.push(`structuredContent keys: ${Object.keys(structured).join(', ')}`)
  if (first) parts.push(`starts: ${JSON.stringify(first.slice(0, 160))}`)
  return parts.join('; ')
}

// Claude Code does not hand a plugin an MCP result past its size limit: it
// saves the whole result to a file and hands over a note naming that file in
// its place ("Error: result (65,407 characters) exceeds maximum allowed
// tokens. Output has been saved to /…/tool-results/….txt."). A Jira search
// of fifty issues is past that limit, and fifty is the tool's smallest page.
export function spilledPath(result: { content: readonly unknown[] }): string | undefined {
  for (const block of result.content) {
    const text = str(obj(block)?.text)
    const match = text && /saved to (\/\S+?\.(?:txt|json))\b/.exec(text)
    if (match?.[1]) return match[1]
  }
  return undefined
}

// The words of a failed MCP call, for the pane's error line.
export function mcpErrorText(result: { content: readonly unknown[] }): string {
  const text = result.content
    .map(block => str(obj(block)?.text))
    .filter((t): t is string => t !== undefined)
    .join(' ')
    .trim()
  return text.length > 0 ? text.slice(0, 300) : 'the Jira server refused the call'
}

// One page of `searchJiraIssuesUsingJql`: `{ issues: { nodes, pageInfo } }`
// as the Atlassian MCP answers it, or the REST API's bare `{ issues: [] }`.
export function parseSearch(json: unknown): { cards: Card[]; next?: string; isSearch: boolean } {
  const root = obj(json)
  const issues = root?.issues
  const nodes = Array.isArray(issues) ? issues : obj(issues)?.nodes
  const isSearch = Array.isArray(nodes)
  const pageInfo = obj(obj(issues)?.pageInfo)
  const next =
    pageInfo?.hasNextPage === true ? str(pageInfo.endCursor) : str(root?.nextPageToken)
  const cards: Card[] = []
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const card = parseIssue(node)
    if (card) cards.push(card)
  }
  return { cards, next, isSearch }
}

export function parseIssue(node: unknown): Card | undefined {
  const issue = obj(node)
  const key = str(issue?.key)
  const fields = obj(issue?.fields)
  if (!key || !fields) return undefined
  const status = obj(fields.status)
  const category = obj(status?.statusCategory)
  return {
    key,
    summary: str(fields.summary) ?? '',
    type: str(obj(fields.issuetype)?.name) ?? 'Issue',
    priority: str(obj(fields.priority)?.name),
    assignee: str(obj(fields.assignee)?.displayName),
    status: str(status?.name) ?? 'Unknown',
    statusId: str(status?.id) ?? '',
    category: str(category?.key) ?? 'indeterminate',
    updated: str(fields.updated),
    url: str(issue?.webUrl),
  }
}

// The columns, in board order. An explicit list wins and keeps any status it
// does not name in a trailing column of its own, so nothing goes missing;
// otherwise the statuses seen are ordered by category, then by status id,
// which is creation order and so the order the workflow was built in.
export function groupColumns(cards: readonly Card[], explicit: readonly string[]): Column[] {
  const seen = new Map<string, { category: string; id: number }>()
  for (const card of cards) {
    if (!seen.has(card.status)) {
      seen.set(card.status, { category: card.category, id: Number(card.statusId) || 0 })
    }
  }

  const ordered = [...seen.entries()]
    .sort(([, a], [, b]) => {
      const byCategory = (CATEGORY_ORDER[a.category] ?? 1) - (CATEGORY_ORDER[b.category] ?? 1)
      return byCategory !== 0 ? byCategory : a.id - b.id
    })
    .map(([name]) => name)
  const lower = explicit.map(name => name.toLowerCase())
  const names =
    explicit.length > 0
      ? [...explicit, ...ordered.filter(name => !lower.includes(name.toLowerCase()))]
      : ordered

  return names.map(name => {
    const inColumn = cards.filter(card => card.status.toLowerCase() === name.toLowerCase())
    const category = seen.get(inColumn[0]?.status ?? name)?.category ?? 'indeterminate'
    return { name: inColumn[0]?.status ?? name, category, cards: inColumn }
  })
}

export function parseColumns(setting: string): string[] {
  return setting
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length > 0)
}

export function parseTransitions(json: unknown): Transition[] {
  const list = obj(json)?.transitions
  if (!Array.isArray(list)) return []
  const out: Transition[] = []
  for (const item of list) {
    const t = obj(item)
    const id = str(t?.id)
    const name = str(t?.name)
    if (id && name) out.push({ id, name, to: str(obj(t?.to)?.name) ?? name })
  }
  return out
}

export function buildJql(board: {
  project: string
  doneDays: number
  isMine: boolean
  extra: string
}): string {
  const clauses = [`project = "${board.project.replace(/"/g, '')}"`]
  clauses.push(
    board.doneDays > 0
      ? `(statusCategory != Done OR updated >= -${Math.floor(board.doneDays)}d)`
      : 'statusCategory != Done',
  )
  if (board.isMine) clauses.push('assignee = currentUser()')
  if (board.extra.trim().length > 0) clauses.push(`(${board.extra.trim()})`)
  return `${clauses.join(' AND ')} ORDER BY Rank ASC`
}

// "Ada Lovelace" → "AL"; "cher" → "CH"; nobody → "—".
export function initials(name: string | undefined): string {
  if (!name) return '—'
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '—'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase()
}

export function priorityGlyph(priority: string | undefined): string {
  return (priority && PRIORITY_GLYPH[priority]) ?? '·'
}

export function typeColor(type: string): string {
  return TYPE_COLOR[type] ?? 'text'
}

export function categoryColor(category: string): string {
  return CATEGORY_COLOR[category] ?? 'text'
}

// "3m", "5h", "2d", "just now": short enough for a card's meta line.
export function age(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.max(0, Math.floor((now - then) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// Cut to `width` cells with an ellipsis. Text's own truncation would do this
// on the terminal, but a card's summary also runs over two rows on a wide
// board, which only a cut of our own can bound.
export function clip(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return text.length <= width ? text : `${text.slice(0, width - 1).trimEnd()}…`
}

// How many columns fit side by side: each wants at least `minWidth` cells.
// Below two the board is drawn as tabs instead.
export function sideBySide(bodyColumns: number, columnCount: number, minWidth = 26): boolean {
  return columnCount > 1 && Math.floor(bodyColumns / columnCount) >= minWidth
}

export function boardUrl(board: Pick<Board, 'site' | 'project' | 'boardId'>): string {
  const site = board.site.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return board.boardId
    ? `https://${site}/jira/software/projects/${board.project}/boards/${board.boardId}`
    : `https://${site}/browse/${board.project}`
}

export function issueUrl(site: string, key: string): string {
  return `https://${site.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/browse/${key}`
}
