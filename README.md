# OpenCode Panel

A workout that gets the free OpenCode Zen models working as an agentic chat
inside VS Code — with rich Markdown and CSS-conscious, accessible rendering.

The stock OpenCode extension opens a terminal running the TUI. This one is a
real webview **view** in the secondary sidebar — the same place the default
Chat view lives — that talks to the OpenCode server directly. Sign in to
OpenCode once (`opencode auth login`), pick a free `opencode/*` Zen model such
as `big-pickle`, `minimax-m2.5-free`, `nemotron-3-super-free` or
`mimo-v2-pro-free`, and you get an agentic coding chat (tools, approvals,
sessions, model switching) rendered as readable Markdown with
syntax-highlighted snippets — no API keys, no per-model wiring. It is a pane,
not an editor tab: it shares the sidebar with Chat instead of opening another
coding window.

## Free Zen models (no API key)

[Zen](https://opencode.ai/zen) is OpenCode's curated set of models benchmarked
for coding agents. Several are free and rotate over time. This panel drives the
OpenCode server, and the server makes the model call — so free-tier models work
here even though third-party BYOK clients refuse them. The model dropdown in
the panel header lists everything your server offers, grouped by provider, and
switches the session's model through `session.switchModel`.

```sh
# 1. Install the OpenCode CLI (Windows example; see https://opencode.ai for more)
winget install OpenCode.Opencode
# macOS / Linux:
#   curl -fsSL https://opencode.ai/install | bash

# 2. Sign in so the server can use Zen models (free tier included)
opencode auth login

# 3. Confirm the server sees the free models
opencode models | grep -i -E "free|pickle|minimax|nemotron|mimo"
```

Then open the panel, use the model picker in its header, and choose an
`opencode/…-free` model (e.g. `opencode/big-pickle`). That choice persists per
session; `opencodePanel.model` in settings sets the default for new sessions.

## Why it exists

- **Lives where Chat lives.** A `WebviewView` in the secondary (auxiliary) bar, so
  it reads and behaves like a first-party chat pane rather than an editor tab that
  competes with your files. Its actions sit in the view's title bar, the way the
  built-in Chat view's do.
- **Readable output.** Markdown rendering, syntax highlighting, tool calls folded
  into compact chips, reasoning hidden by default.
- **Editor-native code font.** Snippets render in the font your VS Code is
  configured to use for code (`editor.fontFamily`), falling back to Consolas.
- **Live colour previews.** CSS, SCSS and Less snippets show a swatch next to
  every hex, `rgb()` and `hsl()` literal, so you can see the colour at a glance.
- **A panel that says what it is doing.** While a turn is running, a row of
  blocks sweeps left to right and the status line names the current step
  (`Thinking…`, `Writing…`, `Running bash: pnpm test`).
- **Usage, not a URL.** When a chat is idle, the composer shows its model and
  tokens used, with the in/out/cache breakdown, cost and the server address on
  hover instead of printing the address at the bottom.
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
- **Sessions in VS Code's own Sessions view.** The extension is also a chat
  session provider, so OpenCode sessions show up in the Chat Sessions list next to
  Copilot's and Codex's, and open in a regular chat editor with the same history
  the panel renders. See
  [Chat Sessions view](#chat-sessions-view).

## How it works

```
VS Code webview view  <--postMessage-->  extension host  <--HTTP + SSE-->  opencode serve
```

- `src/panel.ts` registers the pane as a webview view (`panel.PanelController` is
  a `WebviewViewProvider`; VS Code resolves it the first time the container is
  shown, which is also what connects it). It owns the session, the event stream,
  and the transcript. Text deltas are coalesced into 40 ms patches; when a turn
  goes idle the transcript is re-read from the server so the pane always converges
  on authoritative data. Approvals live outside message history, so a reload
  re-merges pending ones from `permission.list()`.
- `src/server.ts` finds the server: `Service.discover()`, falling back to
  `Service.ensure()` (which starts `opencode serve --service`). It authenticates
  with HTTP Basic using the password from the service registration file, and
  sends `x-opencode-directory` so every request is scoped to the workspace folder.
- `src/protocol.ts` is the shared render model. `fromMessages()` maps stored
  history and `applyEvent()` applies live events; both produce the same `Item[]`.
- `src/webview/main.ts` renders items, highlights code with highlight.js, and
  posts snippet actions back to the host.
- `src/vscode-chat.ts` bridges to the chat history VS Code's own Chat view keeps
  on disk. Nothing there is a public API, so the whole format lives in that one
  file.
- `src/sessions.ts` is the other way round: it registers as a chat session
  provider so VS Code asks *us* for the list, instead of us writing files it may
  ignore.

## Install

Prerequisites: VS Code 1.95+, Node 20+, and the OpenCode 2.x CLI with
`opencode auth login` completed (see above). The panel finds a running server
itself, or starts one (`opencode serve --service`), so usually just having the
signed-in CLI is enough.

```sh
git clone https://github.com/wjbetech/opencode-panel.git
cd opencode-panel
pnpm install
pnpm run deploy
```

`deploy` builds, packages, and installs the extension into your VS Code, then
grants it the proposed APIs behind the Sessions view (that last step patches
your local VS Code install — re-run `pnpm run enable-proposed-api` after VS
Code updates). Reload the window, open any folder, and run `OpenCode: Open the
OpenCode Pane` from the command palette. The pane lives in the secondary
sidebar, next to Chat. Open its header model picker and select a free
`opencode/…` Zen model to start chatting for free.

Prefer a file you can carry to another machine? `pnpm run package` writes
`opencode-panel.vsix`; install it via the Extensions view `…` menu → *Install
from VSIX…*. The vsix alone skips the proposed-API grant, so the pane works but
the Sessions-view integration stays dormant until the grant script runs.

No pnpm? `npm install -g pnpm` first, or substitute `npm install` /
`npm run deploy` — pnpm is what the lockfile targets. Use a recent pnpm
(10.16+; 11/12 fine): `pnpm-workspace.yaml` already approves esbuild's
postinstall and disables pnpm 11+'s 24-hour new-package quarantine
(`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`), so a clean clone installs without
extra flags. If you see either error, `git pull` — this repo carries the fix.

## Accessibility: Markdown and CSS that stay readable

- **Rendered Markdown, not terminal text.** Answers arrive as HTML with real
  headings, lists, tables and fenced code — readable with zoom, reflow and
  screen-reader navigation instead of a fixed terminal grid.
- **Theme-aware CSS.** The panel stylesheet (`media/panel.css`) is built on VS
  Code theme variables, follows light/dark/high-contrast themes, keeps a
  visible `:focus-visible` ring on buttons, and uses relative sizing off
  `var(--vscode-font-size)`.
- **Editor-native code font.** Snippets render in the font your VS Code is
  configured to use for code (`editor.fontFamily`), falling back to Consolas.
- **Colour is never emoji-only.** CSS, SCSS and Less snippets show a real
  colour swatch next to every hex, `rgb()` and `hsl()` literal, and the
  `stripColorEmoji` setting (on by default) removes redundant 🟥🟦⬛ squares
  from model output.
- **Calm progress state.** While a turn runs, a sweeping block row plus a
  text status line (`Thinking…`, `Writing…`, `Running bash: …`) names the
  current step instead of flashing raw deltas.

## VS Code Chat hand-off

**Import** (`Import` in the view's `…` title-bar menu, or the command) lists the
chats VS Code has stored, with the ones from this workspace first. The chosen chat
becomes a real OpenCode session: each question and answer is replayed as its own
user/assistant pair, so the model reads the earlier work as its own history, and
`#file` references come across as message attachments.

**Backport** (`Backport` in the same menu) writes the session the pane is showing
into the Chat view's store, so the VS Code side sees the same conversation.

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

## Chat Sessions view

VS Code's Sessions list is fed by *chat session providers* - the same interface
Copilot and Codex register. `src/sessions.ts` registers one, so this directory's
OpenCode sessions appear in that list and open in an ordinary chat editor:

- The list is `session.list` narrowed to the workspace folder, newest first, and
  it refreshes after the panel creates, imports or prompts a session.
- Opening an item builds the conversation with `fromMessages()` - the same render
  model the panel uses - so questions, answers, code fences and tool lines read
  the same in both places. The session's own title is used for the editor.

**A session opened here is read-only.** Continuing a conversation from the VS Code
chat editor would mean forwarding its prompts to the server from this extension,
approval cards included; that is not wired up yet. The stand-in participant
answers with a pointer back to the panel, and `OpenCode: Open Session in VS Code
Chat` opens the panel's current session there for reading and copying.

### One-time setup

`chatSessionsProvider` is a **proposed** API, and VS Code only hands proposed APIs
to extensions named in its own `product.json` - the list that already enables it
for `GitHub.copilot-chat` and `openai.chatgpt`:

```sh
pnpm run enable-proposed-api        # adds this extension to VS Code's product.json
pnpm run enable-proposed-api -- --check   # report state without writing
```

Restart VS Code afterwards, and re-run it after a VS Code update, which replaces
`product.json`. `pnpm run deploy` runs it as its last step.

The extension's manifest deliberately does **not** declare the proposal. Declaring
one that `product.json` has not granted makes VS Code refuse to activate the whole
extension, which would take the panel down with it. Without the grant the
extension logs that the Sessions view is off and nothing else changes.

## Commands

| Command | What it does |
| --- | --- |
| `OpenCode: Open the OpenCode Pane` | Reveals (and focuses) the pane in the secondary sidebar |
| `OpenCode: New Session in Pane` | Starts a fresh session |
| `OpenCode: Delete Current Session in Pane` | Deletes the open chat after confirmation, then starts a fresh session |
| `OpenCode: Open Existing Session in Pane` | Picks from sessions in this directory |
| `OpenCode: Refresh Pane` | Re-reads the transcript and the model list |
| `OpenCode: Reload Pane Webview` | Re-creates the pane's webview document (a dev escape hatch for a missed hot reload) |
| `OpenCode: Import VS Code Chat into Pane` | Picks a Chat view conversation and imports it |
| `OpenCode: Backport Pane Session to VS Code Chat` | Writes this session into the Chat view's history |
| `OpenCode: Open Session in VS Code Chat` | Opens this session (read-only) in a chat editor, the way the Sessions list does |
| `OpenCode: Start Server in Terminal` | Starts `opencode serve --service` in an integrated terminal (avoids flashing PowerShell windows on Windows; see below) |
| `OpenCode: Set Pane Text Size` | Picks the pane text size (also in Menu > Text size) |
| `OpenCode: Show Pane Diagnostics` | Server URL, session, transcript size, chat store, index-write support, Sessions view state |

The pane's own actions (New, Sessions, Refresh, Import, Backport, Open in Chat,
Diagnostics) live in the view's **title bar**: New, Sessions and Refresh show as
icons, the rest collapse into the `…` menu, exactly like the built-in Chat view.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `opencodePanel.serverUrl` | `""` | Explicit server URL; empty auto-discovers |
| `opencodePanel.serverPassword` | `""` | Password for a remote server (Basic `opencode:<password>`); may also be embedded as `http://opencode:pass@host:port` in `serverUrl` |
| `opencodePanel.remoteDirectory` | `""` | Directory as the remote server sees it; required in direct-remote mode when it differs from the local folder |
| `opencodePanel.agent` | `""` | Agent id for new sessions |
| `opencodePanel.model` | `""` | `provider/model` new sessions start on; the header picker changes the current session |
| `opencodePanel.showReasoning` | `false` | Show thinking blocks |
| `opencodePanel.stripColorEmoji` | `true` | Strip color-square emojis (🟥 🟦 ⬛) from model output; CSS snippets already show real swatches |
| `opencodePanel.fontScale` | `1` | Pane text size as a zoom factor (`0.85`, `1`, `1.15`, `1.3`); also adjustable from Menu > Text size |

## Remote server (shared chats over Tailscale)

One OpenCode server on your home server holds all chats; PC and laptop both
connect over Tailscale. Server setup automation (`ops/opencode-remote/`, with
`setup.sh`, DB backups and client smoke tests) is being re-added; until then
the two VS Code patterns are: **Remote-SSH** (recommended — no settings
needed, panel runs next to the code) and **direct remote** (`serverUrl` +
`serverPassword` + `remoteDirectory`).

## Develop

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm run serve      # opencode serve --service attached to this terminal (see Server notes)
pnpm run smoke      # headless end-to-end check: streaming + approvals
pnpm run handoff    # end-to-end check: VS Code chat -> OpenCode -> VS Code chat
pnpm run inspect    # dump one session, then watch the raw event stream
pnpm run deploy     # build + package + install into VS Code, then grant the Sessions view API
pnpm run enable-proposed-api   # only the product.json grant, with --check to just report
```

`pnpm run deploy` patches VS Code's `product.json` (see
[Chat Sessions view](#chat-sessions-view)), so restart VS Code after deploying.

The Sessions view integration can be exercised without clicking: with
`OPENCODE_PANEL_SELF_CHECK=1` in the environment, the extension lists sessions on
activation and opens the newest one in a chat editor, logging both to the
**OpenCode Panel** channel. An isolated-profile harness that uses it lives in
`%TEMP%/opencode/probe-sessions.mjs`.

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

`pnpm run deploy` installs the extension, so `OpenCode: Open the OpenCode Pane` is
available from the command palette in **any** window - including a project you are
reviewing code for. Reload the window after deploying (extensions load at startup),
then reveal the pane; it appears in the secondary sidebar alongside Chat.

The pane is a contributed view, so it does not replace the built-in Chat view by
itself - VS Code has no API to swap a first-party view. To make it the only thing
in that bar: right-click the **Chat** view's header and *Hide*, then drag the
**OpenCode** view to the top. VS Code remembers the layout per window.

To debug instead, open this folder in its own VS Code window and press `F5`
(the "Run OpenCode Panel" config). F5 reads the launch configuration of the
*open folder*, so it does nothing if this folder is not the one open. To see
how agent files behave, use File > Open Folder in the F5 window to open the
project you want to test: the panel follows the folder change, reconnects the
server client for that directory, and lists its agents and chats. That includes
your VS Code custom agents - `.github/agents/*.agent.md` (and legacy
`.github/chatmodes/*.chatmode.md`) appear as a `workspace` group in the agent
picker, and picking one applies the file as session instructions. Saving a file
then hitting Refresh re-scans with no restart. If the
folder dialog misbehaves, use `Run OpenCode Panel in Folder…` instead: it
prompts for a folder path and opens the development window directly on it,
no dialog needed.

Pane logs go to the **OpenCode Panel** output channel; `OpenCode: Show Pane
Diagnostics` prints the server URL, session and transcript size. Webview
rendering issues are visible via `Developer: Open Webview Developer Tools`.

`pnpm run inspect` takes an optional session id and a watch window:

```sh
node dist/inspect.mjs ses_abc123 --seconds 20
```

### Hot reload

`F5` starts the **watch** task, so esbuild rebuilds `dist/` on every save and the
extension pushes the result into the running editor - no window reload:

- `src/webview/main.ts` and `media/panel.css` are re-loaded into the open pane.
  The extension host keeps running, so the session, the event stream and the
  transcript survive; the pane is re-rendered from the host's copy.
- `src/panel.ts`, `src/extension.ts` and the rest of the host code cannot be
  re-required in a live host. The watcher logs `Extension host bundle rebuilt`
  to the **OpenCode Panel** channel; run `Developer: Restart Extension Host`
  (or press `Ctrl+Shift+F5`) to load it. That is much cheaper than a window
  reload, and VS Code restores the pane and its session afterwards.

Hot reload is on whenever the extension runs from source (VS Code reports
`ExtensionMode.Development` under `F5`). Set `OPENCODE_PANEL_DEV=1` in the
extension host environment to force it on for an installed build. If a change
still does not show, `OpenCode: Reload Pane Webview` re-creates the document.

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
- `session.list({ directory })` is unusable from the client: it serializes inputs
  into the query string, and backslashes do not survive that (`C:\Users\me` is sent
  as `C:Usersme`), which the server answers with an empty 500. `listSessions()` in
  `src/server.ts` pages the list unscoped and matches `location.directory` itself,
  ignoring case and slash direction - the same folder is recorded as `c:\…` when
  VS Code created the session and `C:\…` otherwise.
- `project.list()` returns the array directly (not `{ data }`), and one directory
  can have more than one project id - the importer prefers the project an
  existing session in that directory already uses.
- **Windows: flashing PowerShell windows come from a console-less server, not
  the panel.** A server started without a console (for example another app's
  background service) gives every shell the agent runs a fresh visible console
  window, so PowerShell pops open and closed per tool call.
  `OpenCode: Start Server in Terminal` (or `pnpm run serve`) fixes it: after
  confirmation it stops the registered background server, starts
  `opencode serve --service` in an integrated terminal whose console the tool
  shells share, waits for the new registration, and reconnects the pane onto
  it. If the Desktop app is still running its own background service, quit it
  (or disable its autostart) so it does not reclaim the registration.

## Known gaps

- The pane cannot *replace* the built-in Chat view: it is a contributed view in the
  same bar, which VS Code shows alongside Chat rather than instead of it. Hiding
  Chat is a per-window layout change the user makes, not something the extension
  can do.
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
  the index write succeeds and the window is reloaded. VS Code rewrites that index
  from memory whenever chat state changes, so an entry written from outside can be
  dropped before VS Code ever reads it. The **Sessions** pane is a different list:
  it is fed by providers, which is what `src/sessions.ts` registers.
- Sessions opened in the Sessions view are read-only. Prompts typed there are not
  forwarded to the server yet, and the approval cards have no equivalent in that
  editor.
- The Sessions view needs a proposed API, so it depends on the `product.json`
  grant and goes quiet after a VS Code update until
  `pnpm run enable-proposed-api` is run again.
- Imports carry prose, code and file references. Tool calls become a one-line
  note each, and reasoning is dropped, because VS Code's response stream mixes
  presentation details with content.
