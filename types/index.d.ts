// The jira-board mod's state contract: every value it keeps in `$.state`.
// Bump an atom's `shape` tag in hooks/register.tsx whenever one of these
// changes, so a value an earlier version stored is declined after a reload.

export type Card = {
  key: string
  summary: string
  type: string
  priority?: string
  assignee?: string
  status: string
  statusId: string
  // Jira's status category key: `new`, `indeterminate` or `done`.
  category: string
  updated?: string
  url?: string
}

export type Column = { name: string; category: string; cards: Card[] }

export type Board = {
  site: string
  project: string
  boardId: string
  cards: Card[]
  fetchedAt: number
}

export type Fetch = { isLoading: boolean; error?: string }

export type View = {
  // The tab shown when the columns do not fit side by side.
  column?: string
  // The issue opened in the detail view.
  selected?: string
  isMine: boolean
}

export type Transition = { id: string; name: string; to: string }

export type Moves = {
  key: string
  list: Transition[]
  isLoading: boolean
  error?: string
  // The issue itself when it is not on the board (opened by `/jira KEY`).
  card?: Card
}

declare module 'claude-code' {
  interface PluginState {
    'jira-board': {
      board: Shaped<Board | null>
      fetch: Shaped<Fetch>
      view: Shaped<View>
      moves: Shaped<Moves | null>
    }
  }
}
