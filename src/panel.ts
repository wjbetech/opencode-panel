import * as vscode from "vscode"
import * as path from "node:path"
import type { OpenCodeEvent, SessionImportInput } from "@opencode/client"
import {
  applyEvent,
  emptyTranscript,
  fromMessages,
  lastAssistant,
  mergePermissions,
  modelKey,
  permissionItemsFromRequests,
  resolvePermission,
  sessionIDOfEvent,
  toTokenUsage,
  type AgentChoice,
  type ChatSummary,
  type CommandChoice,
  type Item,
  type ModelChoice,
  type PermissionDecision,
  type RevertInfo,
  type SessionUsage,
  type SkillChoice,
  type Transcript,
} from "./protocol"
import { discoverService, listSessions, NoServerAvailableError, resolveClient, stopService, type ResolvedClient } from "./server"
import { readStagedImages, stageImages } from "./stage-images"
import type { StagedImage } from "./stage-images"
import { scanWorkspaceAgents, type WorkspaceAgentFile } from "./workspace-agents"
import type { ChatSessions } from "./sessions"
import {
  chatStoreRoot,
  findWorkspaceDir,
  fromOpenCodeExport,
  importDefaults,
  listChatSessions,
  newSessionID,
  sameFolder,
  toOpenCodeImport,
  updateChatIndex,
  userRootFromGlobalStorage,
  writeChatSession,
  type ImportDefaults,
  type OpenCodeModel,
} from "./vscode-chat"

/** The webview view this controller drives; must match the `views` contribution. */
export const VIEW_ID = "opencodePanel.view"

/** The view container holding that view; must match `viewsContainers`. */
const CONTAINER_ID = "opencodePanel"

const SESSION_KEY = "opencodePanel.sessionID"
/** Last model picked in the chats pane; a new chat starts on it. */
const MODEL_KEY = "opencodePanel.lastModel"
/** Text sizes the menu submenu and the QuickPick offer; the webview scales type by the factor. */
const FONT_SCALES = [0.85, 1, 1.15, 1.3]
/** Last agent picked in the composer bar; a new chat starts on it. */
const AGENT_KEY = "opencodePanel.lastAgent"
/** Session-instructions entry holding the active workspace agent file. */
const WORKSPACE_AGENT_KEY = "opencode-panel.workspace-agent"
/** Global-state key for the URL the terminal server last registered at. */
const TERMINAL_URL_KEY = "opencodePanel.terminalServerUrl"
/** Picker-id prefix for `.github/agents` files; never sent to the server. */
const WORKSPACE_AGENT_PREFIX = "workspace:"
const RECONCILE_DELAY_MS = 300
const PATCH_FLUSH_MS = 40
/** Bursts of chat-state events are folded into one chats update. */
const CHATS_FLUSH_MS = 200

/** Session ids this pane created or imported (global: follows you across folders). */
const PANE_IDS_KEY = "opencodePanel.paneSessionIDs"
/** Remember at most this many; oldest first out. Listing order is newest-first. */
const PANE_IDS_CAP = 500

/** A chat as the chats pane needs it, before the live state is folded in. */
type ChatEntry = {
  id: string
  title: string
  model: string
  agent: string
  parentID: string
  /** Server `time.created`; the list sorts on this so activity never reshuffles it. */
  created: number
  /** Server `time.updated`; shown as a relative age so rows match the TUI list. */
  updated: number
}

/** Aliases people (and models) write in fences, mapped to VS Code language ids. */
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  pwsh: "powershell",
  ps1: "powershell",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  cs: "csharp",
  "c#": "csharp",
  kt: "kotlin",
  golang: "go",
  htm: "html",
  txt: "plaintext",
  text: "plaintext",
  "": "plaintext",
}

function languageId(alias: string): string {
  const key = alias.trim().toLowerCase()
  return LANGUAGE_ALIASES[key] ?? (key.length > 0 ? key : "plaintext")
}

/** `provider/model` from settings, or undefined when it is empty or malformed. */
function parseModel(value: string): OpenCodeModel | undefined {
  const trimmed = value.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * An error plus whatever the server said about it.
 *
 * A rejected request can arrive as a perfectly generic `Error` whose useful
 * detail (status, response body) hangs off extra properties, which would
 * otherwise be lost by the time the message reaches the panel.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const extra = error as { status?: unknown; body?: unknown; data?: unknown; response?: unknown }
  const parts: string[] = [error.message]
  if (extra.status !== undefined) parts.push(`status ${String(extra.status)}`)
  for (const key of ["body", "data", "response"] as const) {
    const value = extra[key]
    if (value === undefined) continue
    try {
      parts.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    } catch {
      parts.push(`${key}: (unserialisable)`)
    }
  }
  const described = parts.join(" — ")
  return described.length > 1200 ? `${described.slice(0, 1200)}…` : described
}

function createdOf(message: unknown): number {
  const time = (message as { time?: { created?: unknown } }).time
  return typeof time?.created === "number" ? time.created : 0
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class PanelController implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined
  /** The active chat's transcript; the pane shows one chat at a time. */
  private transcript: Transcript = emptyTranscript()
  private resolved: ResolvedClient | undefined
  private sessionID: string | undefined
  private sessionTitle: string | undefined
  private events: AbortController | undefined
  private disabled = false

  /** Remembers the mismatch warning so a reclaimed registration nags once per session. */
  private warnedServerMismatch = false

  /** In-flight connection, so parallel callers share one attempt. */
  private connecting: Promise<void> | undefined

  private readonly pendingItems = new Map<string, Item>()
  private pendingBusy = false
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Sessions running a turn right now.
   *
   * `running` follows the live event stream, `runningNow` is replaced by each
   * `session.active` query. They are unioned so a chat that starts working while
   * a query is in flight cannot be dropped by that query's older answer.
   */
  private running = new Set<string>()
  private runningNow = new Set<string>()

  /** Pending approval ids per chat, so working chats can be flagged. */
  private readonly waiting = new Map<string, Set<string>>()

  /** Chats in this folder, as last listed from the server. */
  private chatList: ChatEntry[] = []
  private chatsTimer: ReturnType<typeof setTimeout> | undefined
  private chatsRefresh = false

  /** Server model catalog, fetched once per connection. */
  private modelChoices: ModelChoice[] | undefined

  /** Server agent catalog, fetched once per connection. */
  private agentChoices: AgentChoice[] | undefined

  /** Workspace `.github/agents` files by picker id (`workspace:<name>`). */
  private readonly workspaceAgentFiles = new Map<string, WorkspaceAgentFile>()

  /** Workspace agent active per chat; the server agent underneath is untouched. */
  private readonly sessionWorkspaceAgents = new Map<string, string>()

  /** Server skill catalog, fetched once per connection. */
  private skillChoices: SkillChoice[] | undefined

  /** Slash-command catalog, fetched once per connection. */
  private commandChoices: CommandChoice[] | undefined

  /** A staged file-undo checkpoint waiting for commit or dismiss. */
  private pendingRevert: RevertInfo | undefined

  /** Agent the active chat runs with; "" until the server says. */
  private currentAgent = ""

  /** Mode of that agent (`primary`/`subagent`/`all`); "" until known. */
  private currentAgentMode = ""

  /** Variant the active chat runs with; "" means the model default. */
  private currentVariant = ""

  /** Last skill activated per chat via `session.skill`; skills are one-shot. */
  private readonly sessionSkills = new Map<string, string>()

  /** The active chat's running totals, for the composer's status strip. */
  private usage: SessionUsage | undefined

  /**
   * When true, rebuilt assets are loaded with a cache-busting query so a
   * hot reload picks up the new bundle instead of a cached one.
   */
  private readonly dev: boolean

  private readonly output: vscode.OutputChannel

  constructor(
    private readonly context: vscode.ExtensionContext,
    output?: vscode.OutputChannel,
    private readonly sessions?: ChatSessions,
  ) {
    this.dev =
      context.extensionMode === vscode.ExtensionMode.Development || process.env.OPENCODE_PANEL_DEV === "1"

    if (output) {
      this.output = output
      return
    }
    // Standalone use (scripts, tests) still gets a channel of its own.
    this.output = vscode.window.createOutputChannel("OpenCode Panel")
    context.subscriptions.push(this.output)
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Bring the pane into view, then make sure it is connected.
   *
   * The pane lives in the secondary sidebar, so there is nothing to create: if
   * the view has never been shown VS Code resolves it as the container reveals,
   * which is also what connects it.
   */
  async open(options: { startNew?: boolean } = {}): Promise<void> {
    await this.reveal()
    await this.ensureConnected()
    if (options.startNew) await this.startNewSession()
  }

  /**
   * Start the OpenCode server attached to a VS Code terminal, then move the
   * pane onto it.
   *
   * Windows background: a server started console-less (for example a GUI
   * app's background service) gives every shell the agent runs a fresh
   * visible console window, so a PowerShell window pops open and closed per
   * tool call. A server running in an integrated terminal shares that
   * terminal's console instead, and the flashing stops. Reuses the
   * "OpenCode Server" terminal when it already exists.
   *
   * A newly started `serve --service` refuses to register while another
   * service holds the registration, so a registered server is stopped first
   * (after confirmation) and the pane reconnects once the new one answers.
   */
  startServer(): void {
    void this.startServerAndAdopt()
  }

  private async startServerAndAdopt(): Promise<void> {
    const name = "OpenCode Server"
    const terminal =
      vscode.window.terminals.find((candidate) => candidate.name === name) ??
      vscode.window.createTerminal({ name })
    terminal.show()

    let previous: string | undefined
    try {
      previous = (await discoverService())?.url
    } catch {
      previous = undefined
    }

    if (previous) {
      const choice = await vscode.window.showWarningMessage(
        `Stop the current background server (${previous}) and start a new one in the terminal? In-flight turns will be interrupted. The console-less background service is what makes PowerShell windows pop open per tool call.`,
        { modal: true },
        "Stop and restart",
      )
      if (choice !== "Stop and restart") return
      try {
        await stopService()
        this.log(`Stopped background server at ${previous}`)
      } catch (error) {
        this.postNotice("error", `Could not stop the background server: ${messageOf(error)}`)
        return
      }
      // Let the port release before the new server binds.
      await sleep(1500)
    }

    terminal.sendText("opencode serve --service", true)
    this.log("Started `opencode serve --service` in the OpenCode Server terminal")
    vscode.window.setStatusBarMessage("OpenCode: waiting for the terminal server…", 10000)

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (!this.view) return
      await sleep(1000)
      let url = ""
      try {
        url = (await discoverService())?.url ?? ""
      } catch {
        url = ""
      }
      if (url.length > 0) {
        this.log(`Server registered at ${url} - reconnecting the pane`)
        await this.context.globalState.update(TERMINAL_URL_KEY, url)
        this.warnedServerMismatch = false
        await this.reconnectForDirectory()
        vscode.window.setStatusBarMessage(`OpenCode server: ${url}`, 5000)
        return
      }
    }

    this.log("The terminal server did not register within 30s")
    void vscode.window.showWarningMessage(
      "The new server did not register within 30s. Check the OpenCode Server terminal for errors, then run OpenCode: Start Server in Terminal again.",
    )
  }

  /** Reveal the view's container and focus the view itself. */
  private async reveal(): Promise<void> {
    for (const command of [`workbench.view.extension.${CONTAINER_ID}`, `${VIEW_ID}.focus`]) {
      try {
        await vscode.commands.executeCommand(command)
      } catch (error) {
        this.log(`Could not run ${command}: ${messageOf(error)}`)
      }
    }
  }

  /** Called by VS Code the first time the pane becomes visible. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view

    view.webview.options = this.webviewOptions()
    view.webview.html = this.html(view.webview)

    // A view can be resolved more than once (moved, hidden, or restored after a
    // reload), so only the live view may tear the controller down - a late
    // dispose from a previous view would otherwise drop the session that just
    // reconnected.
    view.onDidDispose(() => {
      if (this.view === view) this.teardown()
    })
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message)
    })

    void this.ensureConnected()
  }

  /** Which scripts and styles the view may load. */
  private webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    }
  }

  /**
   * Re-create the webview document in place. Used by the development watcher
   * after the bundle or stylesheet is rebuilt; the host, session and transcript
   * stay put, so this is a refresh rather than a reset.
   */
  reloadWebview(): void {
    if (!this.view) return
    this.view.webview.html = this.html(this.view.webview)
  }

  dispose(): void {
    this.teardown()
  }

  private teardown(): void {
    this.disabled = true
    this.resetConnectionState()
    this.view = undefined
  }

  /** Drop the live connection without forgetting the webview itself. */
  private resetConnectionState(): void {
    this.events?.abort()
    this.events = undefined
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    if (this.chatsTimer) clearTimeout(this.chatsTimer)
    this.flushTimer = undefined
    this.reconcileTimer = undefined
    this.chatsTimer = undefined
    this.resolved = undefined
    this.sessionID = undefined
    this.modelChoices = undefined
    this.agentChoices = undefined
    this.skillChoices = undefined
    this.commandChoices = undefined
    this.pendingRevert = undefined
    this.workspaceAgentFiles.clear()
    this.sessionWorkspaceAgents.clear()
    this.currentAgent = ""
    this.currentAgentMode = ""
    this.currentVariant = ""
    this.sessionSkills.clear()
    this.usage = undefined
    this.chatList = []
    this.running.clear()
    this.runningNow.clear()
    this.waiting.clear()
  }

  /**
   * Reconnect when the open folder changes (for example File > Open Folder
   * in the F5 window): the client, session and catalogs all belong to the
   * previous directory. The stored session is per workspace, so the new
   * folder picks up its own chat (or starts one) along with its agent files.
   */
  async reconnectForDirectory(): Promise<void> {
    const pending = this.connecting
    if (pending) {
      try {
        await pending
      } catch {
        // A failed connect must not block the reconnect.
      }
    }
    this.resetConnectionState()
    this.transcript = emptyTranscript()
    this.postReplace()
    this.log(`Workspace folder changed - reconnecting in ${this.directory()}`)
    await this.ensureConnected()
  }

  /** Connect once, even if several callers ask at the same time. */
  private ensureConnected(): Promise<void> {
    if (this.resolved) {
      // Already connected: a view that resolved later still needs what is on screen.
      if (this.view) {
        this.postReplace()
        void this.refreshChats()
      }
      return Promise.resolve()
    }
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  // ------------------------------------------------------------------ session

  private async connect(): Promise<void> {
    try {
      const directory = this.directory()
      const config = vscode.workspace.getConfiguration("opencodePanel")
      const overrideUrl = config.get<string>("serverUrl") ?? ""
      this.resolved = await resolveClient({
        directory,
        overrideUrl,
        password: config.get<string>("serverPassword") ?? "",
        remoteDirectory: config.get<string>("remoteDirectory") ?? "",
        // Windows: never boot the detached console-less service behind the
        // user's back — that is the PowerShell-flashing server. Offer the
        // terminal server instead (see the NoServerAvailableError branch).
        autoStart: process.platform !== "win32",
        log: (message) => this.log(message),
      })
      this.checkTerminalServer()

      const stored = this.context.workspaceState.get<string>(SESSION_KEY)
      if (stored && (await this.sessionExists(stored))) this.sessionID = stored

      if (!this.sessionID) await this.createSession()
      await this.restoreWorkspaceAgent()
      this.disabled = false
      this.subscribe()
      await this.reload()
      await this.refreshChats()
    } catch (error) {
      if (error instanceof NoServerAvailableError) {
        this.log("No server registered; offering the terminal server")
        this.postNotice(
          "error",
          "No OpenCode server is running. Start one in a terminal so agent shells share its console (no flashing PowerShell windows).",
        )
        const choice = await vscode.window.showWarningMessage(
          "No OpenCode server is running. Start one in a terminal?",
          "Start Server in Terminal",
          "Dismiss",
        )
        if (choice === "Start Server in Terminal") this.startServer()
        return
      }
      this.postNotice("error", `Could not connect to OpenCode: ${messageOf(error)}`)
    }
  }

  /**
   * Warn once per session when the pane lands on a different server than the
   * adopted terminal one — usually a GUI app reclaiming the registration,
   * which brings the flashing console-less server back.
   */
  private checkTerminalServer(): void {
    if (!this.resolved || this.warnedServerMismatch) return
    // Remote mode is intentional: the URL comes from settings, not discovery.
    if ((vscode.workspace.getConfiguration("opencodePanel").get<string>("serverUrl") ?? "").trim().length > 0) return
    const adopted = this.context.globalState.get<string>(TERMINAL_URL_KEY) ?? ""
    if (adopted.length === 0 || this.resolved.url === adopted) return
    this.warnedServerMismatch = true
    this.log(`Connected to ${this.resolved.url}, not the terminal server at ${adopted}`)
    void vscode.window
      .showWarningMessage(
        `Connected to ${this.resolved.url} instead of your terminal server. Another app may have reclaimed the registration (flashing PowerShell windows can return).`,
        "Start Server in Terminal",
        "Keep This Server",
      )
      .then((choice) => {
        if (choice === "Start Server in Terminal") this.startServer()
        else this.log(`Staying on ${this.resolved?.url ?? "(unknown)"} for this session`)
      })
  }

  private directory(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  }

  /**
   * Directory as the server sees it. In remote mode (`serverUrl` +
   * `remoteDirectory`) agent tools run on the server, so sessions are scoped
   * to the server path; otherwise this is the local workspace folder.
   */
  private serverDirectory(): string {
    return this.resolved?.directory ?? this.directory()
  }

  private async sessionExists(sessionID: string): Promise<boolean> {
    try {
      const info = await this.client().session.get({ sessionID })
      this.sessionTitle = info.title
      return true
    } catch {
      this.log(`Stored session ${sessionID} is gone`)
      return false
    }
  }

  private client(): ResolvedClient["client"] {
    if (!this.resolved) throw new Error("Not connected to an OpenCode server yet")
    return this.resolved.client
  }

  private async createSession(): Promise<void> {
    const config = vscode.workspace.getConfiguration("opencodePanel")
    const folder = vscode.workspace.workspaceFolders?.[0]?.name ?? "workspace"
    const preferred = this.preferredAgent()
    // Workspace ids are files, not server agents: create plain, then apply.
    const agent = preferred.startsWith(WORKSPACE_AGENT_PREFIX) ? "" : preferred
    const modelRef = this.preferredModel()

    const info = await this.client().session.create({
      title: `Panel · ${folder}`,
      location: { directory: this.serverDirectory() },
      ...(agent.length > 0 ? { agent } : {}),
      ...(modelRef ? { model: modelRef } : {}),
    })

    this.sessionID = info.id
    this.sessionTitle = info.title
    if (typeof info.agent === "string" && info.agent.length > 0) this.currentAgent = info.agent
    await this.context.workspaceState.update(SESSION_KEY, info.id)
    this.recordPaneSession(info.id)
    this.log(`Created session ${info.id}`)
    if (preferred.startsWith(WORKSPACE_AGENT_PREFIX)) {
      // Scan first so the remembered file resolves even on a fresh window.
      await this.loadWorkspaceAgents()
      await this.applyWorkspaceAgent(preferred)
    }
    this.sessions?.notifyChanged()
  }

  /**
   * Which agent a new chat starts on.
   *
   * The last agent picked in the composer bar wins; the `opencodePanel.agent`
   * setting is the fallback. Empty leaves the server default.
   */
  private preferredAgent(): string {
    const remembered = (this.context.workspaceState.get<string>(AGENT_KEY) ?? "").trim()
    if (remembered.length > 0) return remembered
    return (vscode.workspace.getConfiguration("opencodePanel").get<string>("agent") ?? "").trim()
  }

  /**
   * Which model a new chat starts on.
   *
   * The last model picked in the chats pane wins, so a new chat continues on whatever
   * you were just using; the `opencodePanel.model` setting is the fallback for a
   * window that has never picked one. Undefined leaves the server's default.
   */
  private preferredModel(): OpenCodeModel | undefined {
    const remembered = (this.context.workspaceState.get<string>(MODEL_KEY) ?? "").trim()
    if (remembered.length > 0) {
      const parsed = parseModel(remembered)
      if (parsed) return parsed
      this.log(`Ignoring remembered model "${remembered}": expected provider/model`)
    }

    const configured = (vscode.workspace.getConfiguration("opencodePanel").get<string>("model") ?? "").trim()
    if (configured.length === 0) return undefined
    const parsed = parseModel(configured)
    if (!parsed) this.log(`Ignoring opencodePanel.model "${configured}": expected provider/model`)
    return parsed
  }

  async startNewSession(): Promise<void> {
    try {
      await this.ensureConnected()
      await this.createSession()
      await this.reload()
      await this.refreshChats()
    } catch (error) {
      this.postNotice("error", messageOf(error))
    }
  }

  /**
   * Delete the chat on screen, after an explicit confirmation.
   *
   * The server drops the session and its history; the pane then starts a
   * fresh chat so it is never left pointing at a session that no longer
   * exists. Nothing happens when there is no active chat or the user backs
   * out of the confirmation.
   */
  async deleteCurrentSession(): Promise<void> {
    try {
      await this.ensureConnected()
      if (!this.resolved || !this.sessionID) {
        this.postNotice("error", "No open chat to delete.")
        return
      }
      const id = this.sessionID
      const title = this.sessionTitle?.trim() || id
      const choice = await vscode.window.showWarningMessage(
        `Delete chat "${title}"? Its history will be lost and this cannot be undone.`,
        { modal: true },
        "Delete",
      )
      if (choice !== "Delete" || this.sessionID !== id) return

      await this.client().session.remove({ sessionID: id })
      this.log(`Deleted session ${id}`)
      this.sessionSkills.delete(id)
      this.pendingItems.clear()
      this.pendingBusy = false
      this.sessionID = undefined
      this.sessionTitle = undefined
      await this.createSession()
      await this.reload()
      await this.refreshChats()
      this.sessions?.notifyChanged()
      vscode.window.setStatusBarMessage(`Deleted "${title}"`, 3000)
    } catch (error) {
      this.postNotice("error", `Could not delete that chat: ${describeError(error)}`)
    }
  }

  /** Rename the open chat (QuickPick input, server `session.update`). */
  async renameCurrentSession(): Promise<void> {
    try {
      await this.ensureConnected()
      if (!this.resolved || !this.sessionID) {
        this.postNotice("error", "No open chat to rename.")
        return
      }
      const current = this.sessionTitle?.trim() || ""
      const title = await vscode.window.showInputBox({
        title: "Rename chat",
        value: current,
        prompt: "A short name for this chat, shown in the chats pane and the TUI",
        validateInput: (value) => (value.trim().length > 0 ? undefined : "Title can't be empty"),
      })
      if (title === undefined || title.trim() === current) return
      await this.client().session.update({ sessionID: this.sessionID, title: title.trim() })
      this.sessionTitle = title.trim()
      this.log(`Renamed session ${this.sessionID} to "${this.sessionTitle}"`)
      await this.refreshChats()
      this.sessions?.notifyChanged()
      vscode.window.setStatusBarMessage(`Renamed to "${this.sessionTitle}"`, 3000)
    } catch (error) {
      this.postNotice("error", `Could not rename that chat: ${describeError(error)}`)
    }
  }

  /**
   * Compact the open chat's history into a summary, freeing context.
   * The summary lands as a turn like any other; the pane reconciles on idle.
   */
  async compactSession(): Promise<void> {
    try {
      await this.ensureConnected()
      if (!this.resolved || !this.sessionID) {
        this.postNotice("error", "No open chat to compact.")
        return
      }
      const choice = await vscode.window.showWarningMessage(
        `Compact "${this.sessionTitle?.trim() || this.sessionID}"? Older turns are summarized to free context. The summary stays in history, but per-message Undo checkpoints for compacted turns stop resolving.`,
        { modal: true },
        "Compact",
      )
      if (choice !== "Compact") return
      this.transcript.busy = true
      this.postReplace()
      await this.client().session.compact({ sessionID: this.sessionID })
      this.setRunning(this.sessionID, true)
      this.log(`Compacting session ${this.sessionID}`)
      vscode.window.setStatusBarMessage("Compacting chat history…", 4000)
    } catch (error) {
      this.transcript.busy = false
      this.postNotice("error", `Could not compact that chat: ${describeError(error)}`)
    }
  }

  /**
   * Re-send the last user message as a fresh turn (the TUI regenerates; the
   * API has no in-place retry, so a new turn is the honest equivalent).
   */
  async retryTurn(): Promise<void> {
    try {
      await this.ensureConnected()
      if (!this.resolved || !this.sessionID) {
        this.postNotice("error", "Not connected to an OpenCode session yet.")
        return
      }
      if (this.transcript.busy) {
        this.postNotice("info", "That chat is still working - Stop it first, then retry.")
        return
      }
      const last = [...this.transcript.items].reverse().find((item) => item.kind === "user")
      if (!last || last.kind !== "user" || last.text.trim().length === 0) {
        this.postNotice("info", "Nothing to retry yet - send a prompt first.")
        return
      }
      vscode.window.setStatusBarMessage("Retrying last prompt as a new turn", 3000)
      await this.sendPrompt(last.text, undefined, undefined)
    } catch (error) {
      this.postNotice("error", `Could not retry: ${messageOf(error)}`)
    }
  }

  /** Pane text size as a zoom factor; unknown values fall back to 100%. */
  private fontScale(): number {
    const scale = vscode.workspace.getConfiguration("opencodePanel").get<number>("fontScale") ?? 1
    return FONT_SCALES.includes(scale) ? scale : 1
  }

  /** Push the current text size; used after the setting changes elsewhere. */
  async syncFontScale(): Promise<void> {
    if (!this.view) return
    await this.post({ type: "fontScale", fontScale: this.fontScale() })
  }

  /** Native-modal alternative to the menu submenu: pick the pane text size. */
  async pickFontScale(): Promise<void> {
    const scale = this.fontScale()
    const picks = FONT_SCALES.map((value) => ({
      label: `${value === scale ? "✓ " : ""}${Math.round(value * 100)}%`,
      description: value === 0.85 ? "Compact" : value === 1 ? "Default" : value === 1.15 ? "Large" : "Extra large",
      value,
    }))
    const choice = await vscode.window.showQuickPick(picks, {
      title: "OpenCode pane text size",
      placeHolder: "Pick a text size for the pane",
    })
    if (choice) await this.setFontScale(choice.value)
  }

  /** Validate, persist and broadcast a new pane text size. */
  private async setFontScale(scale: number): Promise<void> {
    if (!FONT_SCALES.includes(scale)) return
    await vscode.workspace.getConfiguration("opencodePanel").update("fontScale", scale, vscode.ConfigurationTarget.Global)
    this.log(`Text size set to ${Math.round(scale * 100)}%`)
    await this.syncFontScale()
  }

  /** Re-read the transcript and the model catalog; the title bar's Refresh. */
  async refresh(): Promise<void> {
    try {
      await this.ensureConnected()
      await this.reload()
      await this.refreshChats()
    } catch (error) {
      this.postNotice("error", messageOf(error))
    }
  }

  /**
   * Show another chat.
   *
   * Its transcript is re-read from the server rather than kept in memory: a chat
   * that is not on screen keeps running on the server, so history is the only
   * honest source for what it has said while you were looking elsewhere.
   */
  async switchChat(id: string): Promise<void> {
    if (id.length === 0) return
    try {
      await this.ensureConnected()
      if (id === this.sessionID) return

      const entry = this.chatList.find((chat) => chat.id === id)
      this.sessionID = id
      this.sessionTitle = entry?.title ?? id
      await this.context.workspaceState.update(SESSION_KEY, id)
      // Patches queued for the old chat must not land in the new one.
      this.pendingItems.clear()
      this.pendingBusy = false
      // Highlight the new chat in the chats pane before its history arrives.
      await this.postChats()
      await this.restoreWorkspaceAgent()
      await this.reload()
      this.log(`Switched to chat ${id}`)
    } catch (error) {
      this.postNotice("error", `Could not open that chat: ${describeError(error)}`)
    }
  }

  async pickSession(): Promise<void> {
    try {
      await this.ensureConnected()
      const sessions = await listSessions(this.client(), this.serverDirectory(), { limit: 50 })
      const picks = sessions.map((session) => ({
        label: session.title?.trim() || session.id,
        description: new Date(session.time.updated).toLocaleString(),
        detail: session.id,
        id: session.id,
      }))
      if (picks.length === 0) {
        void vscode.window.showInformationMessage("No OpenCode sessions found for this directory.")
        return
      }
      const choice = await vscode.window.showQuickPick(picks, {
        title: "OpenCode sessions",
        placeHolder: "Pick a session to load in the pane",
      })
      if (!choice) return
      this.sessionID = choice.id
      this.sessionTitle = choice.label
      await this.context.workspaceState.update(SESSION_KEY, choice.id)
      await this.open()
      this.pendingItems.clear()
      this.pendingBusy = false
      await this.reload()
      await this.refreshChats()
    } catch (error) {
      this.postNotice("error", messageOf(error))
    }
  }

  // -------------------------------------------------------------------- chats

  /** Ids this pane created or imported, oldest first; seeded from `Panel ·` titles. */
  private paneSessionIDs(): string[] {
    const stored = this.context.globalState.get<string[]>(PANE_IDS_KEY)
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []
  }

  /** Remember a chat as pane-born so the list can badge its origin. */
  private recordPaneSession(id: string): void {
    if (id.length === 0) return
    const ids = this.paneSessionIDs().filter((candidate) => candidate !== id)
    ids.push(id)
    void this.context.globalState.update(PANE_IDS_KEY, ids.slice(-PANE_IDS_CAP))
  }

  /** The chats pane's view of this folder: every chat, with what it is doing. */
  private async refreshChats(): Promise<void> {
    if (!this.resolved) return
    try {
      const sessions = await listSessions(this.client(), this.serverDirectory(), { limit: 50 })
      const active = this.sessionID
      this.chatList = sessions.map((session) => ({
        id: session.id,
        title: session.title?.trim() || session.id,
        model: modelKey(session.model),
        agent: typeof session.agent === "string" ? session.agent : "",
        parentID: typeof session.parentID === "string" ? session.parentID : "",
        created: session.time?.created ?? 0,
        updated: session.time?.updated ?? 0,
      }))
      // Stable newest-first by creation time: a chat that runs or updates must
      // not jump the list, so `updated` is deliberately not the sort key.
      this.chatList.sort((left, right) => right.created - left.created)
      // Chats this pane started (titled `Panel · …` until the first rename)
      // predate origin tracking: seed them so old pane chats badge correctly.
      const known = new Set(this.paneSessionIDs())
      const seeded = this.chatList
        .filter((chat) => !known.has(chat.id) && chat.title.startsWith("Panel · "))
        .map((chat) => chat.id)
      if (seeded.length > 0) {
        void this.context.globalState.update(
          PANE_IDS_KEY,
          [...known, ...seeded].slice(-PANE_IDS_CAP),
        )
        for (const id of seeded) known.add(id)
      }
      if (active && !this.chatList.some((chat) => chat.id === active)) {
        this.chatList.unshift({
          id: active,
          title: this.sessionTitle ?? active,
          model: "",
          agent: "",
          parentID: "",
          created: 0,
          updated: 0,
        })
      }
    } catch (error) {
      this.log(`Could not list chats: ${messageOf(error)}`)
    }

    try {
      // Authoritative for chats that were already working when the pane opened,
      // which no event will announce: the stream only reports changes.
      const running = await this.client().session.active()
      this.runningNow = new Set(Object.keys(running ?? {}))
    } catch (error) {
      this.log(`Could not read running sessions: ${messageOf(error)}`)
    }

    await this.postChats()
  }

  /** Post the chats pane from the last listing, folding in the live state. */
  private async postChats(): Promise<void> {
    if (!this.view) return
    const active = this.sessionID
    const paneIDs = new Set(this.paneSessionIDs())
    const chats: ChatSummary[] = this.chatList.map((chat) => ({
      id: chat.id,
      title: chat.title,
      model: chat.model,
      agent: chat.agent,
      parentID: chat.parentID,
      updated: chat.updated,
      origin: paneIDs.has(chat.id) ? "pane" : "tui",
      busy: this.isRunning(chat.id),
      waiting: this.waiting.get(chat.id)?.size ?? 0,
      active: chat.id === active,
    }))
    if (active && !chats.some((chat) => chat.active)) {
      chats.unshift({
        id: active,
        title: this.sessionTitle ?? active,
        model: "",
        agent: "",
        parentID: "",
        updated: 0,
        origin: paneIDs.has(active) ? "pane" : "tui",
        busy: this.isRunning(active),
        waiting: this.waiting.get(active)?.size ?? 0,
        active: true,
      })
    }
    await this.post({ type: "chats", chats })
  }

  /** Coalesce the bursts of state changes a single turn produces. */
  private scheduleChats(refresh = false): void {
    if (refresh) this.chatsRefresh = true
    if (this.chatsTimer) return
    this.chatsTimer = setTimeout(() => {
      this.chatsTimer = undefined
      const stale = this.chatsRefresh
      this.chatsRefresh = false
      void (stale ? this.refreshChats() : this.postChats())
    }, CHATS_FLUSH_MS)
  }

  private isRunning(sessionID: string): boolean {
    return this.running.has(sessionID) || this.runningNow.has(sessionID)
  }

  private setRunning(sessionID: string, value: boolean): void {
    for (const set of [this.running, this.runningNow]) {
      if (value) set.add(sessionID)
      else set.delete(sessionID)
    }
  }

  // ------------------------------------------------------- VS Code chat bridge

  /** Where VS Code keeps chat sessions for this user. */
  private chatStore(): string {
    return chatStoreRoot(userRootFromGlobalStorage(this.context.globalStorageUri.fsPath))
  }

  /**
   * Agent, model and project for an imported session.
   *
   * Imported assistant messages have to name an agent and a model the server can
   * resolve, and a directory with no history offers neither, so this falls back
   * to the server's own catalogs. A blank project id is fine: the server files
   * the session under the project for `location.directory`.
   */
  private async resolveImportDefaults(): Promise<ImportDefaults> {
    return importDefaults(this.client(), this.serverDirectory(), (message) => this.log(message))
  }

  // -------------------------------------------------------------------- model

  /** The models the server offers, as picker entries. */
  private async loadModels(): Promise<ModelChoice[]> {
    const models = await this.client().model.list()
    const list = Array.isArray(models) ? models : models.data
    return list
      .filter((model) => model.enabled !== false)
      .map((model) => {
        // The type says `name` is always there; the server sometimes disagrees,
        // and a blank label is a blank row in the picker. Fall back down the chain.
        const name = typeof model.name === "string" ? model.name : ""
        const id = model.modelID ?? model.id ?? ""
        const key = `${model.providerID}/${id}`
        const variants = Array.isArray(model.variants)
          ? model.variants
              .map((variant: { id?: unknown }) => (typeof variant.id === "string" ? variant.id : ""))
              .filter((entry: string) => entry.length > 0)
          : []
        const context =
          model.limit && typeof model.limit.context === "number" && model.limit.context > 0
            ? model.limit.context
            : 0
        return {
          key,
          providerID: model.providerID,
          id,
          label: name.length > 0 ? name : key,
          variants,
          context,
        }
      })
  }

  /** The agents the server offers, as picker entries (hidden ones excluded). */
  private async loadAgents(): Promise<AgentChoice[]> {
    const agents = await this.client().agent.list()
    const list = Array.isArray(agents) ? agents : agents.data
    return list
      .filter((agent) => agent.hidden !== true)
      .map((agent) => ({
        id: agent.id,
        name: agent.name?.length > 0 ? agent.name : agent.id,
        description: typeof agent.description === "string" ? agent.description : "",
        mode: typeof agent.mode === "string" ? agent.mode : "",
        source: "server" as const,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Custom agents from this folder's `.github/agents/*.agent.md` (plus legacy
   * `.github/chatmodes`). Re-scanned every time (cheap: one or two `readdir`s)
   * so saving a file then hitting Refresh picks it up with no restart.
   */
  private async loadWorkspaceAgents(): Promise<AgentChoice[]> {
    const directory = this.serverDirectory()
    let files: WorkspaceAgentFile[]
    try {
      files = await scanWorkspaceAgents(directory)
    } catch (error) {
      this.log(`Could not scan workspace agents: ${messageOf(error)}`)
      return []
    }
    this.workspaceAgentFiles.clear()
    for (const file of files) this.workspaceAgentFiles.set(file.id, file)
    if (files.length > 0) this.log(`Found ${files.length} workspace agent(s): ${files.map((file) => file.name).join(", ")}`)
    return files.map((file) => ({
      id: file.id,
      name: file.name,
      description:
        file.description.length > 0
          ? `${file.description} — ${this.workspaceRelative(file.file)}`
          : this.workspaceRelative(file.file),
      mode: "workspace",
      source: "workspace" as const,
      file: file.file,
    }))
  }

  /** `dir/file` relative to the workspace, for tooltips and logs. */
  private workspaceRelative(file: string): string {
    const relative = vscode.workspace.asRelativePath(file, false)
    return relative.length > 0 ? relative : file
  }

  /** The skills the server offers, as picker entries. */
  private async loadSkills(): Promise<SkillChoice[]> {
    const skills = await this.client().skill.list()
    const list = Array.isArray(skills) ? skills : skills.data
    return list
      .map((skill) => ({
        id: skill.id,
        name: skill.name?.length > 0 ? skill.name : skill.id,
        description: typeof skill.description === "string" ? skill.description : "",
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /** Slash commands the server offers (`/fix`, `/commit`, …). */
  private async loadCommands(): Promise<CommandChoice[]> {
    const commands = await this.client().command.list()
    const list = Array.isArray(commands) ? commands : commands.data
    return list
      .map((command) => ({
        name: command.name,
        description: typeof command.description === "string" ? command.description : "",
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /** Tell the webview which models/agents/skills exist and which one the session is on. */
  private async postSettings(): Promise<void> {
    if (!this.view || !this.resolved) return
    try {
      this.modelChoices = this.modelChoices ?? (await this.loadModels())
    } catch (error) {
      this.log(`Could not list models: ${messageOf(error)}`)
      return
    }
    try {
      this.agentChoices = this.agentChoices ?? (await this.loadAgents())
    } catch (error) {
      this.log(`Could not list agents: ${messageOf(error)}`)
      this.agentChoices = []
    }
    // Workspace files are re-scanned every time: saving a `.agent.md` then
    // hitting Refresh lists it with no restart.
    const workspaceAgents = await this.loadWorkspaceAgents()
    const agents = [...(this.agentChoices ?? []), ...workspaceAgents]
    try {
      this.skillChoices = this.skillChoices ?? (await this.loadSkills())
    } catch (error) {
      this.log(`Could not list skills: ${messageOf(error)}`)
      this.skillChoices = []
    }
    try {
      this.commandChoices = this.commandChoices ?? (await this.loadCommands())
    } catch (error) {
      this.log(`Could not list commands: ${messageOf(error)}`)
      this.commandChoices = []
    }

    let current = ""
    if (this.sessionID) {
      try {
        const info = await this.client().session.get({ sessionID: this.sessionID })
        current = modelKey(info.model)
        // The session carries its own running totals; the model is a bonus.
        this.usage = { tokens: toTokenUsage(info.tokens), cost: info.cost ?? 0 }
        const agent = typeof info.agent === "string" ? info.agent : ""
        this.currentAgent = agent
        const variant = info.model && typeof info.model.variant === "string" ? info.model.variant : ""
        this.currentVariant = variant
        // A workspace agent rides on top of the server agent: the instructions
        // entry is the source of truth for what the bar shows.
        const workspace = this.sessionWorkspaceAgents.get(this.sessionID)
        if (workspace && this.workspaceAgentFiles.has(workspace)) {
          this.currentAgent = workspace
        } else if (workspace) {
          this.sessionWorkspaceAgents.delete(this.sessionID)
        }
        const known = agents.find((entry) => entry.id === this.currentAgent)
        this.currentAgentMode = known?.mode ?? ""
      } catch (error) {
        this.log(`Could not read the session's model: ${messageOf(error)}`)
      }
    }

    const variants = this.modelChoices.find((model) => model.key === current)?.variants ?? []
    // A variant the catalog no longer offers is still shown, so the bar never
    // claims the model default while the session runs on something else.
    if (this.currentVariant.length > 0 && !variants.includes(this.currentVariant)) {
      variants.unshift(this.currentVariant)
    }

    await this.post({
      type: "settings",
      models: this.modelChoices,
      current,
      usage: this.usage,
      fontScale: this.fontScale(),
      agents,
      currentAgent: this.currentAgent,
      agentMode: this.currentAgentMode,
      skills: this.skillChoices,
      currentSkill: this.sessionID ? (this.sessionSkills.get(this.sessionID) ?? "") : "",
      commands: this.commandChoices,
      variants,
      currentVariant: this.currentVariant,
    })
  }

  /** Post just the context bar state (cheap follow-up after skill/agent events). */
  private async postContext(): Promise<void> {
    if (!this.view || !this.resolved) return
    const current = this.sessionID ? (this.sessionSkills.get(this.sessionID) ?? "") : ""
    const workspaceAgents = await this.loadWorkspaceAgents()
    await this.post({
      type: "context",
      agents: [...(this.agentChoices ?? []), ...workspaceAgents],
      currentAgent: this.currentAgent,
      agentMode: this.currentAgentMode,
      skills: this.skillChoices ?? [],
      currentSkill: current,
    })
  }

  private async selectModel(model: OpenCodeModel): Promise<void> {
    if (!this.sessionID) return
    const key = `${model.providerID}/${model.id}`
    try {
      await this.client().session.switchModel({ sessionID: this.sessionID, model })
      // Remembered for the next new chat; this chat keeps the model it has now.
      await this.context.workspaceState.update(MODEL_KEY, key)
      this.log(`Model set to ${key}`)
      vscode.window.setStatusBarMessage(`OpenCode model: ${key}`, 3000)
      await this.postSettings()
      this.scheduleChats(true)
    } catch (error) {
      this.postNotice("error", `Could not switch model: ${describeError(error)}`)
    }
  }

  /**
   * Switch the active chat to another agent, TUI `/agents` picker equivalent.
   *
   * Like the TUI (`local.agent.set`), this is session-level and immediate.
   * Workspace ids (`workspace:<name>`) are `.github/agents` files: the server
   * agent stays put and the file body is applied as session instructions.
   */
  private async selectAgent(agent: string): Promise<void> {
    if (!this.sessionID || agent.trim().length === 0) return
    const id = agent.trim()
    if (id.startsWith(WORKSPACE_AGENT_PREFIX)) {
      await this.applyWorkspaceAgent(id)
      return
    }
    try {
      await this.client().session.switchAgent({ sessionID: this.sessionID, agent: id })
      this.currentAgent = id
      const known = (this.agentChoices ?? []).find((entry) => entry.id === id)
      this.currentAgentMode = known?.mode ?? this.currentAgentMode
      this.sessionWorkspaceAgents.delete(this.sessionID)
      await this.clearWorkspaceAgentEntry()
      await this.context.workspaceState.update(AGENT_KEY, id)
      this.log(`Agent set to ${id}`)
      vscode.window.setStatusBarMessage(`OpenCode agent: ${id}`, 3000)
      await this.postContext()
    } catch (error) {
      this.postNotice("error", `Could not switch agent: ${describeError(error)}`)
    }
  }

  /** Apply a `.github/agents` file to this chat via session instructions. */
  private async applyWorkspaceAgent(id: string): Promise<void> {
    if (!this.sessionID) return
    const file = this.workspaceAgentFiles.get(id)
    if (!file) {
      this.postNotice("error", `That workspace agent is gone - Refresh to re-scan.`)
      return
    }
    try {
      await this.client().session.instructions.entry.put({
        sessionID: this.sessionID,
        key: WORKSPACE_AGENT_KEY,
        value: { name: file.name, file: file.file, content: file.content },
      })
      this.currentAgent = id
      this.currentAgentMode = "workspace"
      this.sessionWorkspaceAgents.set(this.sessionID, id)
      await this.context.workspaceState.update(AGENT_KEY, id)
      this.log(`Workspace agent set to ${file.name} (${this.workspaceRelative(file.file)})`)
      vscode.window.setStatusBarMessage(`OpenCode agent: ${file.name} (workspace)`, 3000)
      await this.postContext()
    } catch (error) {
      this.postNotice("error", `Could not apply workspace agent: ${describeError(error)}`)
    }
  }

  /** Drop the workspace-agent instructions entry, ignoring a missing one. */
  private async clearWorkspaceAgentEntry(): Promise<void> {
    if (!this.sessionID) return
    try {
      await this.client().session.instructions.entry.remove({ sessionID: this.sessionID, key: WORKSPACE_AGENT_KEY })
    } catch (error) {
      this.log(`Could not clear workspace agent entry: ${messageOf(error)}`)
    }
  }

  /**
   * Re-attach the workspace agent a session carries: after a restart or a
   * chat switch the instructions entry outlives our maps, so read it back.
   */
  private async restoreWorkspaceAgent(): Promise<void> {
    if (!this.sessionID) return
    await this.loadWorkspaceAgents()
    try {
      const entries = await this.client().session.instructions.entry.list({ sessionID: this.sessionID })
      const entry = entries.find((candidate) => candidate.key === WORKSPACE_AGENT_KEY)
      const value = entry?.value as { name?: unknown } | undefined
      const name = value && typeof value.name === "string" ? value.name : ""
      const id = name.length > 0 ? `${WORKSPACE_AGENT_PREFIX}${name}` : ""
      if (id.length > 0 && this.workspaceAgentFiles.has(id)) {
        this.sessionWorkspaceAgents.set(this.sessionID, id)
      } else {
        this.sessionWorkspaceAgents.delete(this.sessionID)
      }
    } catch (error) {
      this.log(`Could not read workspace agent entry: ${messageOf(error)}`)
    }
  }

  /**
   * Activate a skill in the active chat, the programmatic side of TUI `/skills`.
   *
   * The TUI inserts an `@skill` mention into the pending prompt; the panel
   * activates immediately via `session.skill` so the effect is visible without
   * composing a prompt first. The `session.skill.activated` event confirms it.
   */
  private async selectSkill(id: string): Promise<void> {
    if (!this.sessionID || id.trim().length === 0) return
    const skillID = id.trim()
    try {
      await this.client().session.skill({ sessionID: this.sessionID, id: skillID })
      this.sessionSkills.set(this.sessionID, skillID)
      this.log(`Skill activated: ${skillID}`)
      vscode.window.setStatusBarMessage(`OpenCode skill: ${skillID}`, 3000)
      await this.postContext()
    } catch (error) {
      this.postNotice("error", `Could not activate skill: ${describeError(error)}`)
    }
  }

  /**
   * Switch the model variant (reasoning effort), TUI `/variants` equivalent.
   *
   * Variants ride on the model reference (`ModelRef.variant`); switching keeps
   * the same model id/provider and only changes the variant. Empty clears it
   * back to the model default.
   */
  private async selectVariant(variant: string): Promise<void> {
    if (!this.sessionID) return
    const current = await this.currentModelRef()
    if (!current) {
      this.postNotice("error", "No model on this chat yet - pick a model first.")
      return
    }
    const trimmed = variant.trim()
    try {
      await this.client().session.switchModel({
        sessionID: this.sessionID,
        model: trimmed.length > 0 ? { ...current, variant: trimmed } : { id: current.id, providerID: current.providerID },
      })
      this.currentVariant = trimmed
      this.log(`Variant set to ${trimmed.length > 0 ? trimmed : "(default)"}`)
      vscode.window.setStatusBarMessage(
        `OpenCode variant: ${trimmed.length > 0 ? trimmed : "default"}`,
        3000,
      )
      await this.postSettings()
    } catch (error) {
      this.postNotice("error", `Could not switch variant: ${describeError(error)}`)
    }
  }

  /** Cycle to the next variant the current model offers (TUI `ctrl+t`). */
  private async cycleVariant(): Promise<void> {
    if (!this.sessionID) return
    const current = await this.currentModelRef()
    if (!current) return
    const choices = this.modelChoices?.find((model) => model.providerID === current.providerID && model.id === current.id)
    const variants = choices?.variants ?? []
    if (variants.length === 0) {
      vscode.window.setStatusBarMessage("This model offers no variants", 2000)
      return
    }
    const at = variants.indexOf(this.currentVariant)
    const next = variants[(at + 1) % variants.length] ?? ""
    await this.selectVariant(next)
  }

  /** The active chat's model reference, for variant switches. */
  private async currentModelRef(): Promise<OpenCodeModel | undefined> {
    if (!this.sessionID) return undefined
    try {
      const info = await this.client().session.get({ sessionID: this.sessionID })
      if (!info.model || typeof info.model.id !== "string") return undefined
      return { id: info.model.id, providerID: info.model.providerID }
    } catch {
      return undefined
    }
  }

  /** Pull a VS Code Chat conversation in as a real OpenCode session. */
  async importChatSession(): Promise<void> {
    try {
      await this.ensureConnected()

      const directory = this.directory()
      const sessions = listChatSessions(this.chatStore()).filter((session) => session.turns.length > 0)
      if (sessions.length === 0) {
        void vscode.window.showInformationMessage(
          "No VS Code chat sessions were found on disk. Chat a little in the Chat view first.",
        )
        return
      }

      sessions.sort((left, right) => {
        const leftHere = sameFolder(left.folder, directory) ? 1 : 0
        const rightHere = sameFolder(right.folder, directory) ? 1 : 0
        return rightHere - leftHere || right.lastMessageDate - left.lastMessageDate
      })

      const picks = sessions.map((session) => {
        const here = sameFolder(session.folder, directory)
        return {
          label: session.title,
          description: `${new Date(session.lastMessageDate).toLocaleString()} · ${session.turns.length} turn${
            session.turns.length === 1 ? "" : "s"
          }${here ? "" : " · other workspace"}`,
          detail: session.folder,
          session,
        }
      })

      const choice = await vscode.window.showQuickPick(picks, {
        title: "VS Code chat sessions",
        placeHolder: "Pick a chat to bring into the pane",
        matchOnDescription: true,
        matchOnDetail: true,
      })
      if (!choice) return

      const sessionID = newSessionID()
      const defaults = await this.resolveImportDefaults()
      const payload = toOpenCodeImport(choice.session, {
        sessionID,
        projectID: defaults.projectID,
        directory: this.serverDirectory(),
        agent: defaults.agent,
        model: defaults.model,
      })

      await this.client().session.import(payload as unknown as SessionImportInput)

      this.sessionID = sessionID
      this.sessionTitle = choice.session.title
      await this.context.workspaceState.update(SESSION_KEY, sessionID)
      this.recordPaneSession(sessionID)
      this.log(
        `Imported VS Code chat ${choice.session.sessionId} as ${sessionID} (${choice.session.turns.length} turns, ${payload.messages.length} messages, ${payload.summarisedTurns} summarised)`,
      )
      this.sessions?.notifyChanged()

      await this.open()
      this.pendingItems.clear()
      this.pendingBusy = false
      await this.reload()
      await this.refreshChats()
      vscode.window.setStatusBarMessage(
        payload.summarisedTurns > 0
          ? `Imported "${choice.session.title}" - the oldest ${payload.summarisedTurns} turns are summarised in the first message`
          : `Imported "${choice.session.title}"`,
        6000,
      )
    } catch (error) {
      this.postNotice("error", `Import failed: ${describeError(error)}`)
    }
  }

  /** Write the open session back out so the Chat view shows the same work. */
  async backportChatSession(): Promise<void> {
    if (!this.resolved || !this.sessionID) {
      this.postNotice("error", "Open a session in the pane before backporting.")
      return
    }

    try {
      const directory = this.directory()
      const workspaceDir = findWorkspaceDir(this.chatStore(), directory)
      if (!workspaceDir) {
        void vscode.window.showWarningMessage(
          "VS Code has no chat storage for this workspace yet. Open the Chat view here once, then try again.",
        )
        return
      }

      const exported = await this.client().session.export({ sessionID: this.sessionID })
      const config = vscode.workspace.getConfiguration("opencodePanel")
      const configuredModel = (config.get<string>("model") ?? "").trim()

      const { document, sessionId, indexEntry, turnCount } = fromOpenCodeExport(exported, {
        folder: directory,
        responder: "OpenCode",
        ...(this.sessionTitle === undefined ? {} : { title: this.sessionTitle }),
        ...(configuredModel.length === 0 ? {} : { modelId: configuredModel }),
      })

      if (turnCount === 0) {
        void vscode.window.showInformationMessage(
          "Nothing to backport yet - this pane session has no turns. Ask something in the pane first.",
        )
        return
      }

      const file = writeChatSession(workspaceDir, sessionId, document)
      const index = await updateChatIndex(workspaceDir, sessionId, indexEntry)
      this.log(
        `Backported ${this.sessionID} to ${file} (history index ${index.updated ? "updated" : `skipped: ${index.reason}`})`,
      )

      const title = typeof document.customTitle === "string" ? document.customTitle : "session"
      if (!index.updated) {
        this.postNotice(
          "error",
          `Backported "${title}" to disk, but VS Code's chat history index was not updated (${index.reason}). The session will not appear in Chat history until that write succeeds.`,
        )
        const choice = await vscode.window.showWarningMessage(
          `Backported "${title}" to disk, but the Chat history index was not updated (${index.reason}).`,
          "Show Diagnostics",
          "Show File",
        )
        if (choice === "Show Diagnostics") await vscode.commands.executeCommand("opencodePanel.showStatus")
        if (choice === "Show File") await vscode.window.showTextDocument(vscode.Uri.file(file))
        return
      }

      this.postNotice("info", `Backported "${title}" to VS Code chat. Reload the window to see it in history.`)
      const choice = await vscode.window.showInformationMessage(
        `Backported "${title}" to VS Code chat. Reload the window now to see it in Chat history.`,
        "Reload Window",
        "Show File",
      )
      if (choice === "Reload Window") {
        // VS Code rewrites its own copy of the index whenever chat state changes,
        // which drops this entry, so write it once more and reload straight away.
        await updateChatIndex(workspaceDir, sessionId, indexEntry)
        await vscode.commands.executeCommand("workbench.action.reloadWindow")
      }
      if (choice === "Show File") await vscode.window.showTextDocument(vscode.Uri.file(file))
    } catch (error) {
      this.postNotice("error", `Backport failed: ${describeError(error)}`)
    }
  }

  private async reload(): Promise<void> {
    if (!this.resolved || !this.sessionID) return
    const sessionID = this.sessionID
    try {
      const response = await this.client().message.list({ sessionID })
      const messages = [...response.data].sort((left, right) => createdOf(left) - createdOf(right))
      const transcript = fromMessages(messages)
      // A chat that is working shows the indicator even though history alone
      // cannot say so: the last message is still being written.
      if (this.isRunning(sessionID)) {
        transcript.busy = true
        const last = lastAssistant(transcript)
        if (last) last.streaming = true
      }
      // Switched chats while this was in flight: the answer is for a chat the
      // pane is no longer showing.
      if (this.sessionID !== sessionID) return
      this.transcript = transcript
      // Cleared with the transcript so a switched chat never shows the previous
      // chat's totals; `postSettings` refills it from the session itself.
      this.usage = undefined
      await this.syncPermissions()
      this.postReplace()
      await this.postSettings()
    } catch (error) {
      this.log(`Reload failed: ${messageOf(error)}`)
    }
  }

  /**
   * Re-attach approval requests.
   *
   * Permissions are not part of message history, so replacing the transcript
   * would otherwise drop a card the user still has to answer. `permission.list`
   * reports pending requests only, so nothing answered comes back.
   */
  private async syncPermissions(): Promise<void> {
    if (!this.resolved || !this.sessionID) return
    const sessionID = this.sessionID
    try {
      const pending = await this.client().permission.list({ sessionID })
      mergePermissions(this.transcript, permissionItemsFromRequests(pending))
      // Authoritative for this chat: anything no longer pending was answered.
      this.waiting.set(sessionID, new Set(pending.map((request) => request.id)))
      this.scheduleChats()
    } catch (error) {
      this.log(`Could not list pending permissions: ${messageOf(error)}`)
    }
  }

  private scheduleReconcile(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined
      void this.reload()
    }, RECONCILE_DELAY_MS)
  }

  // -------------------------------------------------------------------- events

  private subscribe(): void {
    this.events?.abort()
    const controller = new AbortController()
    this.events = controller
    void this.consume(controller)
  }

  private async consume(controller: AbortController): Promise<void> {
    const client = this.resolved?.client
    if (!client) return

    let attempt = 0
    while (!controller.signal.aborted && attempt < 5) {
      try {
        // The whole stream, not one session: every chat in the chats pane keeps
        // running on the server, and the pane has to show which ones are.
        for await (const event of client.event.subscribe({ signal: controller.signal })) {
          attempt = 0
          if (controller.signal.aborted) break
          this.handleEvent(event)
        }
      } catch (error) {
        if (controller.signal.aborted) return
        this.log(`Event stream error: ${messageOf(error)}`)
      }
      if (controller.signal.aborted) return
      attempt += 1
      this.log(`Event stream ended; reconnecting (attempt ${attempt})`)
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }

    if (!controller.signal.aborted && attempt >= 5) {
      this.postNotice("error", "Live updates stopped: the event stream kept closing. Use Refresh.")
    }
  }

  /**
   * Route one event.
   *
   * Events for other chats only update the chats pane (a chat can be renamed, finish
   * or ask for approval while the pane shows a different one); events for the
   * chat on screen also drive its transcript.
   */
  private handleEvent(event: OpenCodeEvent): void {
    const sessionID = sessionIDOfEvent(event)
    if (!sessionID) return

    switch (event.type) {
      case "session.execution.started":
        this.setRunning(sessionID, true)
        this.scheduleChats()
        break
      case "session.status": {
        // The one event that says "working" for chats another client started.
        const working = event.data.status.type !== "idle"
        this.setRunning(sessionID, working)
        this.scheduleChats()
        if (sessionID === this.sessionID && this.transcript.busy !== working) {
          this.transcript.busy = working
          if (working) {
            const last = lastAssistant(this.transcript)
            if (last) last.streaming = true
          }
          this.queueBusy()
        }
        break
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.idle":
        this.setRunning(sessionID, false)
        this.scheduleChats()
        break
      case "permission.asked": {
        const pending = this.waiting.get(sessionID) ?? new Set<string>()
        pending.add(event.data.id)
        this.waiting.set(sessionID, pending)
        this.scheduleChats()
        break
      }
      case "permission.replied": {
        this.waiting.get(sessionID)?.delete(event.data.requestID)
        this.scheduleChats()
        break
      }
      case "session.renamed":
        if (sessionID === this.sessionID) this.sessionTitle = event.data.title
        this.scheduleChats(true)
        break
      case "session.model.selected":
        // The picker follows the chat it belongs to, whoever changed the model.
        if (sessionID === this.sessionID) void this.postSettings()
        this.scheduleChats(true)
        break
      case "session.agent.selected": {
        if (sessionID === this.sessionID) {
          const next = (event.data as { agent?: unknown }).agent
          if (typeof next === "string" && next.length > 0) {
            this.currentAgent = next
            const known = (this.agentChoices ?? []).find((entry) => entry.id === next)
            if (known) this.currentAgentMode = known.mode
          }
          void this.postContext()
        }
        break
      }
      case "session.skill.activated": {
        if (sessionID === this.sessionID) {
          const data = event.data as { id?: unknown; name?: unknown }
          const skill = typeof data.id === "string" && data.id.length > 0 ? data.id : ""
          if (skill.length > 0) this.sessionSkills.set(sessionID, skill)
          void this.postContext()
        }
        break
      }
      case "session.usage.updated":
        // Totals for the chat on screen; the chats pane shows only the active one.
        if (sessionID === this.sessionID) {
          this.usage = { tokens: toTokenUsage(event.data.tokens), cost: event.data.cost ?? 0 }
          void this.post({ type: "usage", usage: this.usage })
        }
        break
      case "session.created":
      case "session.deleted":
      case "session.moved":
        this.scheduleChats(true)
        break
      case "session.revert.staged":
      case "session.revert.cleared":
      case "session.revert.committed":
        // Another client staged/cleared/committed: drop our banner and re-read.
        if (sessionID === this.sessionID) {
          this.pendingRevert = undefined
          void this.post({ type: event.type === "session.revert.staged" ? "revertStaged" : "revertCleared" })
          if (event.type === "session.revert.committed") void this.reload()
        }
        break
      default:
        break
    }

    if (sessionID !== this.sessionID) return

    const result = applyEvent(this.transcript, event, sessionID)
    if (!result.changed) return

    if (result.itemID) {
      const item = this.transcript.items.find((candidate) => candidate.id === result.itemID)
      if (item) this.queuePatch(item)
    } else {
      this.queueBusy()
    }

    if (
      event.type === "session.idle" ||
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted"
    ) {
      this.queueBusy()
      this.scheduleReconcile()
    }
  }

  // ------------------------------------------------------------------ outgoing

  private async handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null) return
    const message = raw as Record<string, unknown>
    const text = typeof message.text === "string" ? message.text : ""
    const code = typeof message.code === "string" ? message.code : ""
    const language = typeof message.language === "string" ? message.language : ""
    const reason = typeof message.message === "string" ? message.message : ""

    switch (message.type) {
      case "ready":
        // Render what the host already holds first, so a hot reload shows the
        // transcript at once, then reconcile with the server.
        this.postReplace()
        if (this.resolved) void this.reload()
        return
      case "prompt":
        await this.sendPrompt(text, readAttachments(message.files), readStagedImages(message.images))
        return
      case "command": {
        const name = typeof message.name === "string" ? message.name : ""
        await this.runCommand(name, text)
        return
      }
      case "pickContext":
        await this.pickContext()
        return
      case "pickImage":
        await this.pickImage()
        return
      case "revertStage": {
        const messageID = typeof message.messageID === "string" ? message.messageID : ""
        await this.revertStage(messageID)
        return
      }
      case "revertCommit":
        await this.revertCommit()
        return
      case "revertClear":
        await this.revertClear()
        return
      case "copyChat": {
        const id = typeof message.id === "string" ? message.id : ""
        await this.copyChat(id)
        return
      }
      case "deleteChat": {
        const id = typeof message.id === "string" ? message.id : ""
        await this.deleteChat(id)
        return
      }
      case "copy":
        await vscode.env.clipboard.writeText(code.length > 0 ? code : text)
        vscode.window.setStatusBarMessage("Snippet copied", 2000)
        return
      case "scratch":
        await this.openScratch(language, "", "scratch")
        return
      case "openFilled":
        await this.openScratch(language, code, "snippet")
        return
      case "insert":
        await this.insertAtCursor(code)
        return
      case "openLink": {
        const href = typeof message.href === "string" ? message.href : ""
        if (/^https?:/i.test(href)) await vscode.env.openExternal(vscode.Uri.parse(href))
        return
      }
      case "openFile": {
        const filePath = typeof message.path === "string" ? message.path : ""
        const line = typeof message.line === "number" ? message.line : 1
        const col = typeof message.col === "number" ? message.col : 1
        await this.openFileAt(filePath, line, col)
        return
      }
      case "selectModel": {
        const model = message.model as { id?: unknown; providerID?: unknown; variant?: unknown } | undefined
        const id = typeof model?.id === "string" ? model.id : ""
        const providerID = typeof model?.providerID === "string" ? model.providerID : ""
        if (id.length > 0 && providerID.length > 0) {
          const variant = typeof model?.variant === "string" && model.variant.length > 0 ? model.variant : undefined
          await this.selectModel(variant === undefined ? { id, providerID } : { id, providerID, variant })
        }
        return
      }
      case "selectAgent": {
        const agent = typeof message.agent === "string" ? message.agent : ""
        if (agent.length > 0) await this.selectAgent(agent)
        return
      }
      case "selectSkill": {
        const skill = typeof message.skill === "string" ? message.skill : ""
        if (skill.length > 0) await this.selectSkill(skill)
        return
      }
      case "selectVariant": {
        await this.selectVariant(typeof message.variant === "string" ? message.variant : "")
        return
      }
      case "cycleVariant":
        await this.cycleVariant()
        return
      case "newSession":
        await this.startNewSession()
        return
      case "setFontScale": {
        const scale = typeof message.scale === "number" ? message.scale : NaN
        await this.setFontScale(scale)
        return
      }
      case "deleteSession":
        await this.deleteCurrentSession()
        return
      case "renameSession":
        await this.renameCurrentSession()
        return
      case "compactSession":
        await this.compactSession()
        return
      case "retryTurn":
        await this.retryTurn()
        return
      case "switchChat":
        await this.switchChat(typeof message.id === "string" ? message.id : "")
        return
      case "pickSession":
        await this.pickSession()
        return
      case "importChat":
        await this.importChatSession()
        return
      case "backportChat":
        await this.backportChatSession()
        return
      case "openInChat":
        await this.openSessionInChat()
        return
      case "diagnostics":
        this.showDiagnostics()
        return
      case "refresh":
        await this.refresh()
        return
      case "interrupt":
        await this.interrupt()
        return
      case "permissionReply": {
        const requestID = typeof message.requestID === "string" ? message.requestID : ""
        const decision = message.decision
        if (
          requestID.length > 0 &&
          (decision === "once" || decision === "always" || decision === "reject")
        ) {
          await this.replyPermission(requestID, decision, reason)
        }
        return
      }
      default:
        return
    }
  }

  private async sendPrompt(
    text: string,
    files?: Array<{ uri: string; mention?: { start: number; end: number; text: string } }>,
    stagedImages?: StagedImage[],
  ): Promise<void> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    if (!this.resolved || !this.sessionID) {
      this.postNotice("error", "Not connected to an OpenCode session yet.")
      return
    }

    const localId = `local-${Date.now()}`
    // Stage pasted images before echoing, so the local bubble shows its
    // thumbnails even if the prompt itself then fails to send.
    const staged =
      stagedImages && stagedImages.length > 0
        ? await stageImages(this.context.globalStorageUri, stagedImages, (message) => this.log(message))
        : []
    if (stagedImages && stagedImages.length > 0 && staged.length === 0) {
      this.postNotice("error", "None of the pasted images could be staged (too large or invalid).")
    }
    this.transcript.items.push({
      kind: "user",
      id: localId,
      text: trimmed,
      ...(staged.length > 0 ? { images: staged.map((file) => file.name) } : {}),
    })
    this.transcript.busy = true
    this.postReplace()

    try {
      const attached = [...(files ?? []), ...staged.map(({ uri, mention }) => ({ uri, mention }))]
      await this.client().session.prompt({
        sessionID: this.sessionID,
        text: trimmed,
        ...(attached.length > 0 ? { files: attached } : {}),
      })
      // Running from here on, and the first turn usually renames the session.
      this.setRunning(this.sessionID, true)
      this.scheduleChats(true)
      this.sessions?.notifyChanged()
    } catch (error) {
      this.transcript.busy = false
      this.transcript.items.push({
        kind: "notice",
        id: `notice-${Date.now()}`,
        level: "error",
        text: messageOf(error),
      })
      this.postReplace()
    }
  }

  /**
   * Run a slash command (`/fix`, `/commit`, …) as a turn, the composer
   * equivalent of typing it in the TUI.
   */
  private async runCommand(name: string, text: string): Promise<void> {
    const command = name.trim().replace(/^\//, "")
    const args = text.trim()
    if (command.length === 0) return
    if (!this.resolved || !this.sessionID) {
      this.postNotice("error", "Not connected to an OpenCode session yet.")
      return
    }

    const localId = `local-${Date.now()}`
    this.transcript.items.push({ kind: "user", id: localId, text: `/${command}${args.length > 0 ? ` ${args}` : ""}` })
    this.transcript.busy = true
    this.postReplace()

    try {
      await this.client().session.command({ sessionID: this.sessionID, name: command, text: args })
      this.setRunning(this.sessionID, true)
      this.scheduleChats(true)
      this.sessions?.notifyChanged()
    } catch (error) {
      this.transcript.busy = false
      this.transcript.items.push({
        kind: "notice",
        id: `notice-${Date.now()}`,
        level: "error",
        text: messageOf(error),
      })
      this.postReplace()
    }
  }

  /**
   * Attach editor context to the next prompt: the current selection (with its
   * excerpt), open editors, server references, workspace files, or files with
   * problems. The host owns the picker (native fuzzy QuickPick); the webview
   * owns the chips and the `@token` mention spans.
   */
  private async pickContext(): Promise<void> {
    if (!this.view) return
    const directory = this.directory()
    type Pick = vscode.QuickPickItem & { uri: string; label_: string; excerpt?: string }

    const picks: Pick[] = []
    const seen = new Set<string>()
    const push = (uri: vscode.Uri, detail: string, excerpt?: string): void => {
      const key = uri.toString()
      if (seen.has(key)) return
      seen.add(key)
      const label_ = labelForAttachment(uri, directory)
      picks.push({
        label: label_,
        description: detail,
        detail: vscode.workspace.asRelativePath(uri, false),
        uri: key,
        label_: label_,
        ...(excerpt !== undefined ? { excerpt } : {}),
      })
    }

    const editor = vscode.window.activeTextEditor
    if (editor) {
      const selection = editor.selection
      if (!selection.isEmpty && editor.document.uri.scheme === "file") {
        const start = selection.start.line + 1
        const end = selection.end.line + 1
        const range = start === end ? `${start}` : `${start}–${end}`
        const lines = editor.document.getText(selection).split("\n").slice(0, 40)
        const language = (editor.document.fileName.split(".").pop() ?? "").toLowerCase()
        push(
          editor.document.uri,
          `current selection (${range})`,
          `\n\`\`\`${language}\n${lines.join("\n")}\n\`\`\`\n`,
        )
        // Relabel the pick with its line range.
        const pick = picks[picks.length - 1]
        if (pick) pick.label = `${pick.label_}:${range}`
      }
      push(editor.document.uri, "active editor")
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === "file" && !doc.isUntitled) push(doc.uri, "open editor")
      if (picks.length >= 12) break
    }
    try {
      const refs = await this.client().reference.list({ location: { directory: this.serverDirectory() } })
      const list = Array.isArray(refs) ? refs : refs.data
      for (const ref of list.slice(0, 20)) {
        if (!ref.path) continue
        push(
          vscode.Uri.file(ref.path),
          `reference · ${ref.source.type}${ref.description ? ` — ${ref.description}` : ""}`,
        )
        if (picks.length >= 32) break
      }
    } catch (error) {
      this.log(`Could not list references: ${messageOf(error)}`)
    }
    for (const [uri] of vscode.languages.getDiagnostics()) {
      if ((uri as vscode.Uri).scheme === "file") push(uri as vscode.Uri, "has problems")
    }

    const choice = await vscode.window.showQuickPick<Pick>(picks, {
      title: "Attach context",
      placeHolder: "Pick selection, an open file, or a reference to @-mention",
    })
    if (!choice) {
      const query = await vscode.window.showInputBox({
        title: "Attach context",
        prompt: "Search workspace files by name",
        placeHolder: "e.g. panel",
      })
      if (!query || query.trim().length === 0) return
      const found = await vscode.workspace.findFiles(`**/*${query.trim()}*`, "**/node_modules/**", 15)
      if (found.length === 0) {
        void vscode.window.showInformationMessage(`No workspace files match "${query.trim()}".`)
        return
      }
      const second = await vscode.window.showQuickPick(
        found.map((uri) => ({
          label: labelForAttachment(uri, directory),
          description: vscode.workspace.asRelativePath(uri, false),
          uri: uri.toString(),
        })),
        { title: "Attach context", placeHolder: "Pick a file to @-mention" },
      )
      if (!second) return
      await this.post({
        type: "contextAdded",
        attachment: { uri: second.uri, token: (second as { label: string }).label, label: second.description ?? "" },
      })
      return
    }

    await this.post({
      type: "contextAdded",
      attachment: { uri: choice.uri, token: choice.label_, label: choice.detail ?? "" },
    })
    if (choice.excerpt) await this.post({ type: "insertText", text: choice.excerpt })
  }

  /** Attach images via the native file dialog (multi-select). */
  private async pickImage(): Promise<void> {
    if (!this.view) return
    const chosen = await vscode.window.showOpenDialog({
      title: "Attach images",
      openLabel: "Attach",
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
    })
    if (!chosen || chosen.length === 0) return
    for (const uri of chosen) {
      await this.post({
        type: "contextAdded",
        attachment: {
          uri: uri.toString(),
          token: labelForAttachment(uri, this.directory()),
          label: vscode.workspace.asRelativePath(uri, false),
        },
      })
    }
  }

  /**
   * Stage an undo checkpoint at a user message: the server diffs what changed
   * since and reports the files, which the pane shows for confirm or dismiss.
   */
  private async revertStage(messageID: string): Promise<void> {
    if (!this.resolved || !this.sessionID || messageID.length === 0) return
    if (messageID.startsWith("local-")) {
      this.postNotice("info", "That message has not reached the server yet - try again in a moment.")
      return
    }
    try {
      const revert = await this.client().session.revert.stage({ sessionID: this.sessionID, messageID })
      const files = (revert.files ?? []).map((file) => file.file ?? "").filter((path) => path.length > 0)
      const item = this.transcript.items.find((candidate) => candidate.id === messageID)
      const preview = item && item.kind === "user" ? item.text.slice(0, 80) : messageID
      this.pendingRevert = { messageID, preview, files }
      await this.post({ type: "revertStaged", revert: this.pendingRevert })
    } catch (error) {
      this.postNotice("error", `Could not stage undo: ${describeError(error)}`)
    }
  }

  /** Restore the staged files and rewind the transcript, then re-read. */
  private async revertCommit(): Promise<void> {
    if (!this.resolved || !this.sessionID || !this.pendingRevert) return
    try {
      await this.client().session.revert.commit({ sessionID: this.sessionID })
      this.pendingRevert = undefined
      await this.post({ type: "revertCommitted" })
      this.postNotice("info", "Rewound to the checkpoint and restored files.")
      await this.reload()
      await this.refreshChats()
    } catch (error) {
      this.postNotice("error", `Undo failed: ${describeError(error)}`)
    }
  }

  /** Drop the staged checkpoint without touching files or history. */
  private async revertClear(): Promise<void> {
    if (!this.resolved || !this.sessionID) {
      this.pendingRevert = undefined
      await this.post({ type: "revertCleared" })
      return
    }
    try {
      await this.client().session.revert.clear({ sessionID: this.sessionID })
    } catch (error) {
      this.log(`Could not clear staged revert: ${messageOf(error)}`)
    }
    this.pendingRevert = undefined
    await this.post({ type: "revertCleared" })
  }

  /** Copy a chat's title + session id so it can be pasted elsewhere. */
  private async copyChat(id: string): Promise<void> {
    if (id.length === 0) return
    const entry = this.chatList.find((chat) => chat.id === id)
    const title = entry?.title ?? (id === this.sessionID ? (this.sessionTitle ?? id) : id)
    await vscode.env.clipboard.writeText(`${title} (${id})`)
    vscode.window.setStatusBarMessage("Chat reference copied", 2000)
  }

  /** Delete a chat after an explicit confirm; the open chat falls back to new. */
  private async deleteChat(id: string): Promise<void> {
    if (!this.resolved || id.length === 0) return
    const entry = this.chatList.find((chat) => chat.id === id)
    const title = entry?.title ?? (id === this.sessionID ? (this.sessionTitle ?? id) : id)
    const choice = await vscode.window.showWarningMessage(
      `Delete "${title}"? This removes the session and its history.`,
      { modal: true },
      "Delete",
    )
    if (choice !== "Delete") return
    try {
      await this.client().session.remove({ sessionID: id })
      this.log(`Deleted session ${id}`)
      this.sessions?.notifyChanged()
      if (id === this.sessionID) {
        this.sessionID = undefined
        this.pendingRevert = undefined
        await this.startNewSession()
      }
      await this.refreshChats()
    } catch (error) {
      this.postNotice("error", `Could not delete that chat: ${describeError(error)}`)
    }
  }

  private async interrupt(): Promise<void> {
    if (!this.resolved || !this.sessionID) return
    try {
      await this.client().session.interrupt({ sessionID: this.sessionID })
    } catch (error) {
      this.postNotice("error", messageOf(error))
    }
  }

  /** Answer a pending tool approval and reflect it locally at once. */
  private async replyPermission(
    requestID: string,
    decision: PermissionDecision,
    reason: string,
  ): Promise<void> {
    if (!this.resolved || !this.sessionID) return
    const trimmed = reason.trim()

    try {
      await this.client().permission.reply({
        sessionID: this.sessionID,
        requestID,
        decision,
        ...(trimmed.length > 0 ? { message: trimmed } : {}),
      })
    } catch (error) {
      this.postNotice("error", `Could not answer that request: ${messageOf(error)}`)
      return
    }

    const item = resolvePermission(this.transcript, requestID, decision)
    if (item) this.queuePatch(item)
  }

  private async openScratch(language: string, content: string, name: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
      language: languageId(language),
      content,
    })
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: name === "scratch",
    })
    if (name === "scratch") {
      vscode.window.setStatusBarMessage("Scratch buffer ready - type the snippet here", 3000)
    }
  }

  private async insertAtCursor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      void vscode.window.showWarningMessage("Open a file first, then use Insert.")
      return
    }
    await editor.edit((builder) => builder.insert(editor.selection.active, code))
  }

  /**
   * Open a `path[:line[:col]]` mention from the chat in the editor. Relative
   * paths resolve against the workspace folder; a miss posts a notice rather
   * than opening the wrong file.
   */
  private async openFileAt(filePath: string, line: number, col: number): Promise<void> {
    const trimmed = filePath.trim().replace(/^["'<]|["'>]$/g, "")
    if (trimmed.length === 0) return
    const absolute = path.isAbsolute(trimmed) ? trimmed : path.join(this.directory(), trimmed)
    const uri = vscode.Uri.file(absolute)
    try {
      await vscode.workspace.fs.stat(uri)
    } catch {
      this.postNotice("error", `No such file: ${trimmed}`)
      return
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri)
      const position = new vscode.Position(
        Math.max(0, Math.floor(line) - 1),
        Math.max(0, Math.floor(col) - 1),
      )
      const editor = await vscode.window.showTextDocument(document, { preview: true })
      editor.selection = new vscode.Selection(position, position)
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter,
      )
    } catch (error) {
      this.postNotice("error", `Could not open ${trimmed}: ${describeError(error)}`)
    }
  }

  // ------------------------------------------------------------------ transport

  private queuePatch(item: Item): void {
    this.pendingItems.set(item.id, item)
    this.scheduleFlush()
  }

  private queueBusy(): void {
    this.pendingBusy = true
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      const items = [...this.pendingItems.values()]
      this.pendingItems.clear()
      if (items.length > 0) void this.post({ type: "patch", items })
      if (this.pendingBusy) {
        this.pendingBusy = false
        void this.post({ type: "busy", busy: this.transcript.busy })
      }
    }, PATCH_FLUSH_MS)
  }

  private postReplace(): void {
    if (!this.view) return
    void this.post({
      type: "replace",
      items: this.transcript.items,
      busy: this.transcript.busy,
      usage: this.usage,
      fontScale: this.fontScale(),
      session: { id: this.sessionID ?? "", title: this.sessionTitle ?? "" },
      server: this.resolved ? { url: this.resolved.url, directory: this.resolved.directory } : undefined,
    })
  }

  private postNotice(level: "info" | "error", text: string): void {
    this.log(`${level}: ${text}`)
    const item: Item = { kind: "notice", id: `notice-${Date.now()}-${Math.random()}`, level, text }
    this.transcript.items.push(item)
    this.postReplace()
  }

  private async post(message: unknown): Promise<void> {
    await this.view?.webview.postMessage(message)
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`)
  }

  /**
   * Open this session in VS Code's own chat editor - the same provider the Chat
   * Sessions view lists. Read-only for now: the server's approval prompts are
   * not wired into that stream yet.
   */
  async openSessionInChat(): Promise<void> {
    if (!this.sessions) {
      void vscode.window.showWarningMessage("OpenCode chat sessions are not set up in this window.")
      return
    }
    try {
      if (!this.resolved || !this.sessionID) await this.ensureConnected()
      if (!this.sessionID) return
      await this.sessions.openInChat(this.sessionID)
    } catch (error) {
      this.postNotice("error", `Could not open the session in VS Code Chat: ${describeError(error)}`)
    }
  }

  showDiagnostics(): void {
    this.output.show(true)
    this.log(`Server: ${this.resolved?.url ?? "(not connected)"}`)
    this.log(`Local directory: ${this.directory()}`)
    this.log(`Server directory: ${this.serverDirectory()}${this.resolved?.authenticated ? " (authenticated)" : ""}`)
    this.log(`Session: ${this.sessionID ?? "(not connected)"}`)
    this.log(
      `Chats: ${this.chatList.length} in this folder, ${this.chatList.filter((chat) => this.isRunning(chat.id)).length} working`,
    )
    this.log(
      `Approvals pending: ${[...this.waiting.values()].reduce((total, set) => total + set.size, 0)}`,
    )
    this.log(`Transcript items: ${this.transcript.items.length}`)
    this.log(
      `VS Code chat sessions: ${
        !this.sessions ? "not wired" : this.sessions.available ? "enabled" : "not enabled by VS Code"
      }`,
    )
    this.log(`VS Code chat store: ${this.chatStore()}`)
    this.log(`Extension host node: ${process.versions.node}`)
    void this.reportIndexWriteSupport()
    void vscode.window.showInformationMessage(
      `OpenCode Panel: ${this.resolved ? `connected to ${this.resolved.url}` : "not connected"}`,
    )
  }

  /** Whether this extension host can update VS Code's chat history index. */
  private async reportIndexWriteSupport(): Promise<void> {
    try {
      await import("node:sqlite")
      this.log("node:sqlite: available (backports update the chat history index)")
    } catch (error) {
      this.log(
        `node:sqlite: unavailable (${messageOf(error)}) - backports write session files but leave the history index alone`,
      )
    }
  }

  // ---------------------------------------------------------------------- html

  private html(webview: vscode.Webview): string {
    const nonce = createNonce()
    // In development, bust the webview's asset cache so a hot reload actually
    // shows the rebuild instead of the copy it already loaded.
    const version = this.dev ? `?v=${Date.now()}` : ""
    const script = `${webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"))}${version}`
    const styles = `${webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "panel.css"))}${version}`
    const config = vscode.workspace.getConfiguration("opencodePanel")
    const showReasoning = config.get<boolean>("showReasoning") ?? false
    const stripColorEmoji = config.get<boolean>("stripColorEmoji") ?? true
    // Ship the editor's code font to the webview so snippets match the editor.
    const editorFont = (vscode.workspace.getConfiguration("editor").get<string>("fontFamily") ?? "").trim()
    const fontStyle =
      editorFont.length > 0
        ? `\n    <style>:root { --oc-editor-font: ${escapeCssValue(editorFont)}; }</style>`
        : ""

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styles}" />${fontStyle}
    <title>OpenCode</title>
  </head>
  <body data-show-reasoning="${showReasoning ? "true" : "false"}" data-strip-color-emoji="${stripColorEmoji ? "true" : "false"}">
    <div id="app">
      <div id="top" class="toolbar">
        <div class="nav-row">
          <div class="menu">
            <button id="menu-button" class="menu-button" type="button" aria-haspopup="menu" aria-expanded="false" title="Panel actions">
              <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></svg>
              <span>Menu</span>
              <span class="caret" aria-hidden="true">▾</span>
            </button>
            <div id="menu-list" class="menu-list" role="menu" hidden>
              <button type="button" role="menuitem" data-action="newSession">New chat</button>
              <button type="button" role="menuitem" data-action="pickSession">Open chat…</button>
              <button type="button" role="menuitem" data-action="deleteSession">Delete this chat…</button>
              <button type="button" role="menuitem" data-action="renameSession">Rename this chat…</button>
              <button type="button" role="menuitem" data-action="compactSession">Compact history</button>
              <button type="button" role="menuitem" data-action="retryTurn">Retry last prompt</button>
              <button type="button" role="menuitem" data-action="refresh">Refresh</button>
              <div class="menu-sep" role="separator"></div>
              <button type="button" role="menuitem" data-action="importChat">Import from VS Code chat…</button>
              <button type="button" role="menuitem" data-action="backportChat">Send to VS Code chat</button>
              <button type="button" role="menuitem" data-action="openInChat">Open in VS Code Chat</button>
              <div class="menu-sep" role="separator"></div>
              <div class="menu-sub">
                <button id="menu-font-button" type="button" aria-haspopup="menu" aria-expanded="false" title="Pane text size">
                  <span>Text size</span>
                  <span id="menu-font-value" class="menu-font-value">100%</span>
                  <span class="caret" aria-hidden="true">▸</span>
                </button>
                <div id="menu-font-list" class="menu-sub-list" role="menu" hidden>
                  <button type="button" class="model-option" role="menuitemradio" data-font="0.85"><span class="model-option-label">Compact</span><span class="menu-font-pct">85%</span></button>
                  <button type="button" class="model-option" role="menuitemradio" data-font="1"><span class="model-option-label">Default</span><span class="menu-font-pct">100%</span></button>
                  <button type="button" class="model-option" role="menuitemradio" data-font="1.15"><span class="model-option-label">Large</span><span class="menu-font-pct">115%</span></button>
                  <button type="button" class="model-option" role="menuitemradio" data-font="1.3"><span class="model-option-label">Extra large</span><span class="menu-font-pct">130%</span></button>
                </div>
              </div>
              <div class="menu-sep" role="separator"></div>
              <button type="button" role="menuitem" data-action="diagnostics">Show diagnostics</button>
            </div>
          </div>
          <div class="model">
            <button id="model-button" class="model-button" type="button" disabled aria-haspopup="listbox" aria-expanded="false" title="Model for this chat">
              <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.3" /><path d="M6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2" /></svg>
              <span id="model-label" class="model-label">Model…</span>
              <span class="caret" aria-hidden="true">▾</span>
            </button>
            <div id="model-list" class="model-list" role="listbox" aria-label="Model for this chat" hidden></div>
          </div>
        </div>
        <div id="sessions" class="sessions" role="group" aria-label="Chats"></div>
      </div>
      <main id="messages"></main>
      <footer id="composer">
        <div id="usage-bar" class="usage-bar" hidden><i></i></div>
        <div id="revert-bar" class="revert-bar" hidden></div>
        <div id="attach-bar" class="attach-bar" hidden></div>
        <div id="cmd-wrap" class="cmd-wrap">
          <div id="cmd-list" class="cmd-list" role="listbox" aria-label="Slash commands" hidden></div>
        </div>
        <textarea id="input" rows="3" placeholder="Ask OpenCode…  (Enter to send, Shift+Enter for a new line)"></textarea>
        <div class="composer-row">
          <span id="status" class="status"></span>
          <div class="composer-actions">
            <button id="btn-image" class="icon-btn" type="button" title="Attach an image (or paste / drop one into the box)" aria-label="Attach an image">
              <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="5.5" cy="6.5" r="1.2" /><path d="M2.5 11.5l3.2-3.2 2.3 2.3 2-2 3.5 3.4" /></svg>
            </button>
            <button id="btn-play" class="icon-btn" type="button" title="Send message (Enter)" aria-label="Send message">
              <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" /></svg>
            </button>
            <button id="btn-stop" class="icon-btn" type="button" title="Stop generation (interrupt)" aria-label="Stop generation" hidden>
              <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" /></svg>
            </button>
            <button id="send" class="primary">Send</button>
          </div>
        </div>
        <div id="ctx-bar" class="ctx-bar" role="group" aria-label="Session context">
          <div class="ctx-wrap">
            <button id="agent-button" class="ctx-btn" type="button" aria-haspopup="listbox" aria-expanded="false" title="Agent for this chat (TUI: /agents)">
              <svg class="icon ctx-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5" r="3" /><path d="M2.5 13.5c.8-2.8 2.9-4.2 5.5-4.2s4.7 1.4 5.5 4.2" /></svg>
              <span class="ctx-k">agent</span><span id="agent-label" class="ctx-v">…</span><span class="caret" aria-hidden="true">▾</span>
            </button>
            <div id="agent-list" class="ctx-list" role="listbox" aria-label="Agent for this chat" hidden></div>
          </div>
          <div class="ctx-wrap">
            <button id="skill-button" class="ctx-btn" type="button" aria-haspopup="listbox" aria-expanded="false" title="Activate a skill in this chat (TUI: /skills)">
              <svg class="icon ctx-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l1.5 3.9 3.9 1.5-3.9 1.5L8 12.6l-1.5-3.9-3.9-1.5 3.9-1.5z" /><path d="M12.5 10.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></svg>
              <span class="ctx-k">skill</span><span id="skill-label" class="ctx-v">none</span><span class="caret" aria-hidden="true">▾</span>
            </button>
            <div id="skill-list" class="ctx-list" role="listbox" aria-label="Activate a skill" hidden></div>
          </div>
          <div class="ctx-wrap">
            <button id="variant-button" class="ctx-btn" type="button" aria-haspopup="listbox" aria-expanded="false" title="Model variant / reasoning effort (TUI: /variants, Ctrl+T to cycle)">
              <svg class="icon ctx-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.2h11M2.5 10.8h11" /><circle cx="6" cy="5.2" r="1.7" /><circle cx="10" cy="10.8" r="1.7" /></svg>
              <span class="ctx-k">variant</span><span id="variant-label" class="ctx-v">default</span><span class="caret" aria-hidden="true">▾</span>
            </button>
            <div id="variant-list" class="ctx-list" role="listbox" aria-label="Model variant" hidden></div>
          </div>
          <div class="ctx-wrap">
            <button id="at-button" class="ctx-btn" type="button" title="Attach file context (@-mention in the next prompt)">
              <span class="ctx-ico ctx-at" aria-hidden="true">@</span>
              <span class="ctx-k">@</span><span id="at-label" class="ctx-v">context</span>
            </button>
          </div>
          <span id="mode-badge" class="ctx-mode" title="Agent mode (opencode has no separate harness type; this is the closest native signal)" hidden></span>
        </div>
      </footer>
    </div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`
  }
}

/** Attachments the webview resolved from `@tokens` in the prompt text. */
function readAttachments(
  value: unknown,
): Array<{ uri: string; mention?: { start: number; end: number; text: string } }> {
  if (!Array.isArray(value)) return []
  const files: Array<{ uri: string; mention?: { start: number; end: number; text: string } }> = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const uri = typeof record.uri === "string" ? record.uri : ""
    if (uri.length === 0) continue
    const mention = record.mention as { start?: unknown; end?: unknown; text?: unknown } | undefined
    if (
      mention &&
      typeof mention.start === "number" &&
      typeof mention.end === "number" &&
      typeof mention.text === "string"
    ) {
      files.push({ uri, mention: { start: mention.start, end: mention.end, text: mention.text } })
    } else {
      files.push({ uri })
    }
  }
  return files
}

/** Short `@`-token for a file: basename, or parent/basename on collision. */
function labelForAttachment(uri: vscode.Uri, _directory: string): string {
  const parts = uri.fsPath.split(/[\\/]/).filter((part) => part.length > 0)
  return parts.slice(-1)[0] ?? uri.fsPath
}

/** Keep a user setting from breaking out of the injected `<style>` element. */
function escapeCssValue(value: string): string {
  return value.replace(/[<>]/g, "")
}

function createNonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let value = ""
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }
  return value
}
