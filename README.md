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
  third-party BYOK clients.

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

## Commands

| Command | What it does |
| --- | --- |
| `OpenCode: Open Review Panel` | Opens (or reveals) the panel |
| `OpenCode: New Session in Panel` | Starts a fresh session |
| `OpenCode: Open Existing Session in Panel` | Picks from sessions in this directory |
| `OpenCode: Show Panel Diagnostics` | Server URL, session, transcript size |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `opencodePanel.serverUrl` | `""` | Explicit server URL; empty auto-discovers |
| `opencodePanel.agent` | `""` | Agent id for new sessions |
| `opencodePanel.model` | `""` | `provider/model` for new sessions |
| `opencodePanel.showReasoning` | `false` | Show thinking blocks |

## Develop

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm run smoke      # headless end-to-end check: streaming + approvals
pnpm run inspect    # dump one session, then watch the raw event stream
```

Then press `F5` (Run OpenCode Panel) to launch an Extension Development Host.

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
