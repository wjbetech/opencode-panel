# OpenCode Panel

A VS Code panel for OpenCode sessions, built for reading and typing code by hand.

The stock OpenCode extension opens a terminal running the TUI. This one is a real
webview panel that talks to the OpenCode server directly, so answers arrive as
rendered Markdown with syntax-highlighted snippets and per-snippet actions.

## Why it exists

- **Readable output.** Markdown rendering, syntax highlighting, tool calls folded
  into compact chips, reasoning hidden by default.
- **Approvals in the panel.** When the server wants permission before running a
  tool, a card appears inline with `Allow once`, `Allow always` and `Reject`
  (with an optional reason), so a turn never stalls invisibly.
- **Type-it-yourself workflow.** Every code block gets `Copy`, `Type it`, `Open`,
  `Insert` and `Done`.
  - `Type it` opens an empty untitled file with the right language id beside the
    panel, so you type the snippet into a properly highlighted buffer while the
    reference stays visible.
  - `Done` dims the block once you have typed it.
- **First-party model access.** The extension drives the OpenCode server, and the
  server makes the model call. Free-tier models (for example
  `opencode/deepseek-v4.1-flash-free`) work here even though they are refused by
  third-party BYOK clients. The model dropdown in the header lists everything the
  server offers, grouped by provider, and switches the session's model through
  `session.switchModel`.
- **Hand-off with the VS Code Chat view, both ways.** Bring a conversation out of
  VS Code Chat and keep working on it in the panel, then write the panel session
  back so the Chat view shows the same work. See
  [VS Code Chat hand-off](#vs-code-chat-hand-off).

## How it works

```
VS Code webview  <--postMessage-->  extension host  <--HTTP + SSE-->  opencode serve
```

- `src/server.ts` finds the server: `Service.discover()`, falling back to
  `Service.ensure()` (which starts `opencode serve --service`). It authenticates
  with HTTP Basic using the password from the service registration file, and
  sends `x-opencode-directory` so every request is scoped to the workspace folder.
- `src/protocol.ts` is the shared render model. `fromMessages()` maps stored
  history and `applyEvent()` applies live events; both produce the same `Item[]`.
- `src/panel.ts` owns the session, the event stream, and the panel. Text deltas
  are coalesced into 40 ms patches; when a turn goes idle the transcript is
  re-read from the server so the panel always converges on authoritative data.
  Approvals live outside message history, so a reload re-merges pending ones from
  `permission.list()`.
- `src/webview/main.ts` renders items, highlights code with highlight.js, and
  posts snippet actions back to the host.
- `src/vscode-chat.ts` bridges to the chat history VS Code's own Chat view keeps
  on disk. Nothing there is a public API, so the whole format lives in that one
  file.

## VS Code Chat hand-off

**Import** (`Import` in the panel header, or the command) lists the chats VS Code
has stored, with the ones from this workspace first. The chosen chat becomes a
real OpenCode session: each question and answer is replayed as its own
user/assistant pair, so the model reads the earlier work as its own history, and
`#file` references come across as message attachments.

**Backport** (`Backport` in the panel header) writes the session the panel is
showing into the Chat view's store, so the VS Code side sees the same
conversation.

Where the data lives - verified against VS Code 1.142, and undocumented:

```
<user>/workspaceStorage/<hash>/chatSessions/<id>.jsonl   the session
<user>/workspaceStorage/<hash>/chatSessions/<id>.json    older sessions
<user>/workspaceStorage/<hash>/state.vscdb               chat.ChatSessionStore.index
```

The `.jsonl` files are an operation log: one `{kind: 0, v: …}` snapshot followed
by `{kind: 1, k: […], v}` (set) and `{kind: 2, k: […]}` (append) records, which
`decodeLog()` replays. Sessions that exist in both formats were used to check the
replay: request ids and per-request response counts come out identical.

Two things worth knowing:

- `session.import` stores **at most 50 messages and keeps the newest**. The
  importer stays under the cap and folds the turns that do not fit into a summary
  in the first message, so a 370-turn chat arrives as the last ~24 turns plus a
  list of the older questions.
- The history *list* reads `chat.ChatSessionStore.index`, not the folder, so a
  backport also upserts that index entry. That is a write into VS Code's own
  state database, done via `node:sqlite` as a best-effort step: if the runtime
  has no `node:sqlite`, the session files are still written and the panel says
  so. Reload the window afterwards. VS Code rewrites its own copy of that index
  whenever chat state changes, which drops the new entry, so the panel writes it
  once more immediately before a reload.

An imported session's model comes from whatever this directory already runs with,
never from VS Code's `modelId` (`copilot/…` is not a model this server can
resolve). Assistant messages in an import must name both an agent and a model, so
when a directory has no history to copy them from, they come from the server's
own catalogs - the primary agent and the model it prefers, otherwise the first
active model it offers. A blank project id is fine: the server files the session
under the project for the imported directory.

Backporting a session with no turns is refused rather than written: VS Code hides
empty sessions, so writing one would leave a file in the chat store that never
appears anywhere.

## Commands

| Command | What it does |
| --- | --- |
| `OpenCode: Open Review Panel` | Opens (or reveals) the panel |
| `OpenCode: New Session in Panel` | Starts a fresh session |
| `OpenCode: Open Existing Session in Panel` | Picks from sessions in this directory |
| `OpenCode: Import VS Code Chat into Panel` | Picks a Chat view conversation and imports it |
| `OpenCode: Backport Panel Session to VS Code Chat` | Writes this session into the Chat view's history |
| `OpenCode: Show Panel Diagnostics` | Server URL, session, transcript size, chat store, index-write support |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `opencodePanel.serverUrl` | `""` | Explicit server URL; empty auto-discovers |
| `opencodePanel.agent` | `""` | Agent id for new sessions |
| `opencodePanel.model` | `""` | `provider/model` new sessions start on; the header picker changes the current session |
| `opencodePanel.showReasoning` | `false` | Show thinking blocks |

## Develop

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm run smoke      # headless end-to-end check: streaming + approvals
pnpm run handoff    # end-to-end check: VS Code chat -> OpenCode -> VS Code chat
pnpm run inspect    # dump one session, then watch the raw event stream
pnpm run deploy     # build + package + install into VS Code
```

`pnpm run handoff` reads real sessions from the VS Code chat store, imports one
into an OpenCode session, exports it back, and checks the round trip - including
the history index write, which it exercises against a **copy** of a workspace
`state.vscdb` rather than the live one:

```sh
node dist/handoff.mjs             # newest chat with content
node dist/handoff.mjs --list      # just list what is on disk
node dist/handoff.mjs 0e66a818    # a specific VS Code session id
```

### Running it

`pnpm run deploy` installs the extension, so `OpenCode: Open Review Panel` is
available from the command palette in **any** window - including a project you
are reviewing code for. Reload the window after deploying (extensions load at
startup).

To debug instead, open this folder in its own VS Code window and press `F5`
(the "Run OpenCode Panel" config). F5 reads the launch configuration of the
*open folder*, so it does nothing if this folder is not the one open.

Panel logs go to the **OpenCode Panel** output channel; `OpenCode: Show Panel
Diagnostics` prints the server URL, session and transcript size. Webview
rendering issues are visible via `Developer: Open Webview Developer Tools`.

`pnpm run inspect` takes an optional session id and a watch window:

```sh
node dist/inspect.mjs ses_abc123 --seconds 20
```

## Server notes

Things this extension depends on that were verified against server 2.0.32:

- Auth is HTTP Basic with a fixed username: `opencode:<password>`, where the
  password comes from `<state>/opencode/service.json`.
- Requests are scoped to a directory with the `x-opencode-directory` header,
  and the value must be `encodeURIComponent`-ed.
- Streaming text arrives as `session.text.delta` with an `ordinal`, so a turn
  can interleave text, reasoning and tool parts - the panel keeps them as an
  ordered block list.
- **A turn ends with `session.execution.succeeded`, not `session.idle`.**
  `SessionIdle` exists in the event schema but is not emitted by this version.
  Turning that up is what fixed early attempts at streaming (and the smoke test
  waiting forever for a turn to end).
- The event stream is live-only with no replay, so the panel treats stored
  history as the source of truth and re-reads it when a turn finishes.
- Approvals arrive as `permission.asked`:
  `{ id: "per_…", action: "read", resources: [".env"], save: ["*"],
     source: { type: "tool", messageID: "msg_…", id: "call-…" } }`.
  Answer with `permission.reply({ sessionID, requestID, decision })` where
  decision is `once`, `always` or `reject`. `permission.list()` returns **pending
  requests only**, which is what makes re-merging after a reload safe.
- `session.import` (`/api/experimental/session/import`) takes `{ info, messages,
  location }` shaped exactly like `session.export` returns, **creates** the
  session under `info.id` and refuses an id that already exists, so the importer
  generates `ses_` + 26 base62 characters itself. It silently keeps the newest 50
  messages.
- `session.synthetic({ sessionID, text })` stores a `synthetic` message, but a
  model asked about a detail that existed only in a synthetic message did not
  know it, so the importer does not rely on it for carry-over.
- `project.list()` returns the array directly (not `{ data }`), and one directory
  can have more than one project id - the importer prefers the project an
  existing session in that directory already uses.

## Known gaps

- Interactive `form` prompts (`form.created`) are not rendered yet, so an agent
  that asks a structured question would still appear to stall.
- The permission "always" wording comes straight from the server's `save`
  patterns, which are patterns like `*` rather than prose.
- Session list is a quick pick, not a tree view.
- Reasoning, tool chips and snippets share one column - no collapsed "focus
  mode" yet.
- Code highlighting uses a hand-written light/dark token palette rather than the
  active editor theme, so colours won't match a custom theme exactly.
- The Chat hand-off reads and writes an undocumented on-disk format. Imports miss
  whatever VS Code does not store as a session file (cloud and agent-host
  sessions live elsewhere), and a backport only reaches the Chat history list if
  the index write succeeds and the window is reloaded. VS Code also keeps the
  list the Chat Sessions pane shows in its own cache (`agentSessions.model.cache`)
  and rewrites both that and the history index from memory, so a session written
  from outside can be dropped before VS Code ever reads it. The supported way to
  put sessions in that pane is the `chatSessionsProvider` API, which is still
  proposed in 1.142.
- Imports carry prose, code and file references. Tool calls become a one-line
  note each, and reasoning is dropped, because VS Code's response stream mixes
  presentation details with content.
