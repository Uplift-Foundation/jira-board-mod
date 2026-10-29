// The pane's tree. One function per view, each handed the surface's element
// table, so the same code draws the terminal, desktop, VS Code and mobile.
// Layout is decided by width alone: columns side by side where each gets
// room for a readable card, tabs (one column at a time) everywhere else —
// a docked terminal pane, a phone, a narrow desktop window.

import type { Elements } from 'claude-code'

import type { Board, Card, Column, Fetch, Moves, View } from '../types'
import {
  age,
  boardUrl,
  categoryColor,
  clip,
  groupColumns,
  initials,
  issueUrl,
  parseColumns,
  priorityGlyph,
  sideBySide,
  typeColor,
} from './board'

// The four elements every surface carries; any surface's table fits it.
export type Kit = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Link'>

export type Actions = {
  refresh: () => void
  toggleMine: () => void
  showColumn: (name: string) => void
  open: (key: string) => void
  back: () => void
  move: (key: string, transitionId: string, to: string) => void
}

export type Model = {
  site: string
  project: string
  // Site and project are both set; links go nowhere until they are.
  isSetUp: boolean
  boardId: string
  columnsSetting: string
  board: Board | null
  fetch: Fetch
  view: View
  moves: Moves | null
  bodyColumns: number
  isMobile: boolean
  now: number
}

export function renderPane(ui: Kit, m: Model, act: Actions) {
  const { Box } = ui
  const selected = m.view.selected
  const card =
    selected === undefined
      ? undefined
      : (m.board?.cards.find(c => c.key === selected) ??
        (m.moves?.key === selected ? m.moves.card : undefined))

  return (
    <Box flexDirection="column">
      {header(ui, m, act)}
      {selected !== undefined
        ? detail(ui, m, act, selected, card)
        : body(ui, m, act)}
    </Box>
  )
}

function header(ui: Kit, m: Model, act: Actions) {
  const { Box, Text, Button, Link } = ui
  const count = m.board?.cards.length ?? 0
  const stamp = m.fetch.isLoading
    ? 'refreshing…'
    : m.board
      ? `${count} issue${count === 1 ? '' : 's'} · ${since(m.board.fetchedAt, m.now)}`
      : ''

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
        <Text weight="bold" size="heading">
          {m.project} board
        </Text>
        <Text dimColor size="caption">
          {stamp}
        </Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="refresh" hotkey="r" onPress={act.refresh}>
          Refresh
        </Button>
        <Button
          key="mine"
          hotkey="m"
          variant={m.view.isMine ? 'primary' : 'secondary'}
          onPress={act.toggleMine}
        >
          {m.view.isMine ? 'Mine ✓' : 'Mine'}
        </Button>
        {m.isSetUp && (
          <Link href={boardUrl({ site: m.site, project: m.project, boardId: m.boardId })}>
            Open in Jira ↗
          </Link>
        )}
      </Box>
      {m.fetch.error !== undefined && (
        <Text color="error" wrap="wrap">
          {m.fetch.error}
        </Text>
      )}
    </Box>
  )
}

function body(ui: Kit, m: Model, act: Actions) {
  const { Text } = ui
  if (!m.board) {
    return m.fetch.error !== undefined ? (
      <Text dimColor>Press Refresh to try again.</Text>
    ) : (
      <Text dimColor>Loading {m.project}…</Text>
    )
  }
  const columns = groupColumns(m.board.cards, parseColumns(m.columnsSetting))
  if (columns.length === 0) {
    return <Text dimColor>Nothing on the board{m.view.isMine ? ' assigned to you' : ''}.</Text>
  }
  return !m.isMobile && sideBySide(m.bodyColumns, columns.length)
    ? wide(ui, m, act, columns)
    : tabs(ui, m, act, columns)
}

function wide(ui: Kit, m: Model, act: Actions, columns: Column[]) {
  const { Box, Text } = ui
  const gap = 1
  const width = Math.floor((m.bodyColumns - gap * (columns.length - 1)) / columns.length)
  // A round border's two cells and a cell of padding either side.
  const inner = width - 4

  return (
    <Box flexDirection="row" columnGap={gap} alignItems="flex-start">
      {columns.map(col => (
        <Box
          key={`col:${col.name}`}
          flexDirection="column"
          width={width}
          borderStyle="round"
          borderColor={categoryColor(col.category)}
          paddingX={1}
        >
          <Text weight="bold" color={categoryColor(col.category)}>
            {col.name} <Text dimColor>{String(col.cards.length)}</Text>
          </Text>
          {col.cards.length === 0 && <Text dimColor>—</Text>}
          {col.cards.map(card => cardRow(ui, m, act, card, inner))}
        </Box>
      ))}
    </Box>
  )
}

function tabs(ui: Kit, m: Model, act: Actions, columns: Column[]) {
  const { Box, Text, Button } = ui
  const active =
    columns.find(col => col.name === m.view.column) ??
    columns.find(col => col.category === 'indeterminate' && col.cards.length > 0) ??
    columns[0]!

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {columns.map((col, i) => (
          <Button
            key={`tab:${col.name}`}
            hotkey={i < 9 ? String(i + 1) : undefined}
            variant={col.name === active.name ? 'primary' : 'secondary'}
            onPress={() => act.showColumn(col.name)}
          >
            {col.name} <Text dimColor>{String(col.cards.length)}</Text>
          </Button>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {active.cards.length === 0 && <Text dimColor>No issues in {active.name}.</Text>}
        {active.cards.map(card => cardRow(ui, m, act, card, m.bodyColumns))}
      </Box>
    </Box>
  )
}

// A card: the key and summary are one pressable row, the meta line under it.
function cardRow(ui: Kit, m: Model, act: Actions, card: Card, width: number) {
  const { Box, Text, Button } = ui
  const room = Math.max(8, width - card.key.length - 1)
  const meta = [card.type, `${priorityGlyph(card.priority)} ${card.priority ?? 'None'}`, initials(card.assignee), age(card.updated, m.now)]
    .filter(part => part.length > 0)
    .join(' · ')

  return (
    <Box key={`card:${card.key}`} flexDirection="column" marginBottom={1}>
      <Button key={`open:${card.key}`} plain onPress={() => act.open(card.key)}>
        <Text color={typeColor(card.type)} weight="bold">
          {card.key}
        </Text>{' '}
        {clip(card.summary, room)}
      </Button>
      <Text dimColor size="caption" wrap="truncate-end">
        {meta}
      </Text>
    </Box>
  )
}

function detail(ui: Kit, m: Model, act: Actions, key: string, card: Card | undefined) {
  const { Box, Text, Button, Link } = ui
  const moves = m.moves?.key === key ? m.moves : null
  const choices = (moves?.list ?? []).filter(t => t.to !== card?.status)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" marginBottom={1}>
        <Button key="back" hotkey="b" onPress={act.back}>
          ← Board
        </Button>
      </Box>
      <Text>
        <Text color={card ? typeColor(card.type) : 'text'} weight="bold" size="heading">
          {key}
        </Text>
        {card ? <Text dimColor>{`  ${card.type}`}</Text> : ''}
      </Text>
      {card ? (
        <Box flexDirection="column">
          <Text wrap="wrap" weight="medium">
            {card.summary}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text>
              Status <Text color={categoryColor(card.category)} weight="bold">{card.status}</Text>
            </Text>
            <Text>
              Priority <Text>{`${priorityGlyph(card.priority)} ${card.priority ?? 'None'}`}</Text>
            </Text>
            <Text>
              Assignee <Text>{card.assignee ?? 'Unassigned'}</Text>
            </Text>
            {card.updated !== undefined && (
              <Text dimColor>Updated {age(card.updated, m.now)} ago</Text>
            )}
          </Box>
        </Box>
      ) : (
        <Text dimColor>{moves?.isLoading ? 'Loading…' : 'Not on the board.'}</Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text weight="bold">Move to</Text>
        {moves?.isLoading && <Text dimColor>Loading moves…</Text>}
        {moves?.error !== undefined && <Text color="error" wrap="wrap">{moves.error}</Text>}
        {moves && !moves.isLoading && choices.length === 0 && moves.error === undefined && (
          <Text dimColor>No moves from here.</Text>
        )}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {choices.map(t => (
            <Button key={`move:${t.id}`} onPress={() => act.move(key, t.id, t.to)}>
              {t.to}
            </Button>
          ))}
        </Box>
      </Box>
      <Box marginTop={1}>
        {(card?.url !== undefined || m.isSetUp) && (
          <Link href={card?.url ?? issueUrl(m.site, key)}>Open {key} in Jira ↗</Link>
        )}
      </Box>
    </Box>
  )
}

function since(at: number, now: number): string {
  const text = age(new Date(at).toISOString(), now)
  return text === 'just now' ? 'updated just now' : `updated ${text} ago`
}
