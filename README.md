# jira-board

A Claude Code mod that keeps a live Jira board in a pane beside the chat. It works in the terminal, the desktop app and the mobile app.

- **Wide pane** (desktop, or a wide terminal): the columns sit side by side as bordered lanes, with one card per issue.
- **Narrow pane** (a pane docked beside the terminal transcript, or a phone): one column at a time, with a tab per status. Digits `1`–`9` switch tabs while the pane has focus.
- **Issue detail:** select a card to see its status, priority, assignee and age, plus a button for each status it can move to. Moving an issue calls Jira and refreshes the board.
- **Mine** filters to issues assigned to you. **Refresh** (`r`) re-reads Jira. **Open in Jira** goes to the board on the web.

Jira is read through the Atlassian MCP server your session already has connected, so the mod stores no token of its own. Nothing is fetched while the pane is closed.

## Commands

| Command | What it does |
| --- | --- |
| `/jira` | Open the board |
| `/jira refresh` | Open and re-read now |
| `/jira mine` / `/jira all` | Show your issues, or everyone's |
| `/jira PROJ-123` | Open one issue, even one not on the board |
| `/jira close` | Close the pane |

## Settings

Change these in `/config` → jira-board:

| Setting | Default | |
| --- | --- | --- |
| Jira site | *(required)* | hostname of your Atlassian site, e.g. `yourcompany.atlassian.net` |
| Project key | *(required)* | the `PROJ` in `PROJ-123` |
| Board id | | the number in the board's URL; used only for the Open in Jira link |
| Columns | *(auto)* | comma-separated statuses in board order; when empty, statuses are ordered by category (to do, in progress, done) and then by when the status was created |
| Days of Done | `14` | how far back the Done column reaches; `0` hides done work |
| Extra JQL | | ANDed onto the query |
| Refresh every | `60` s | only while the pane is open |
| Open on session start | off | |
| Atlassian MCP server | *(auto)* | empty picks the connected server that has the Jira search tool |

## Installing

You need Claude Code with an Atlassian MCP server connected (`/mcp`), such as the claude.ai Atlassian connector or Atlassian's remote MCP server.

At the prompt of a terminal session:

```
/plugin install jira-board --marketplace Uplift-Foundation/jira-board-mod
```

From a shell:

```bash
claude plugin install jira-board --marketplace Uplift-Foundation/jira-board-mod
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Uplift-Foundation/jira-board-mod`, then **Add plugin**.

Then set **Jira site** and **Project key** in `/config` → jira-board, and run `/jira`.

### Working on a local clone

The repository is its own marketplace, so Claude Code can read the plugin straight from a clone:

```bash
claude plugin marketplace add ./jira-board-mod
claude plugin install jira-board@uplift-jira-board --scope user
```

After editing a file, run `/reload-plugins` in a session to pick it up. There is nothing to reinstall.

## Developing

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # run a session with the mod loaded from this folder
```

`hooks/board.ts` holds the pure logic (parsing, column order, the query). `hooks/view.tsx` builds the tree for every surface. `hooks/register.tsx` wires up the hooks, the MCP calls and the refresh timer. `types/index.d.ts` is the `$.state` contract.

## License

Apache-2.0. See [LICENSE](LICENSE).
