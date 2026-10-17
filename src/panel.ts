import * as vscode from "vscode"
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
  type ChatSummary,
  type Item,
  type ModelChoice,
  type PermissionDecision,
  type SessionUsage,
  type Transcript,
} from "./protocol"
import { listSessions, resolveClient, type ResolvedClient } from "./server"
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
const RECONCILE_DELAY_MS = 300
const PATCH_FLUSH_MS = 40
/** Bursts of chat-state events are folded into one chats update. */
const CHATS_FLUSH_MS = 200

/** A chat as the chats pane needs it, before the live state is folded in. */
type ChatEntry = { id: string; title: string; model: string }

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

export class PanelController implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined
  /** The active chat's transcript; the pane shows one chat at a time. */
  private transcript: Transcript = emptyTranscript()
  private resolved: ResolvedClient | undefined
  private sessionID: string | undefined
  private sessionTitle: string | undefined
  private events: AbortController | undefined
  private disabled = false

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
    this.events?.abort()
    this.events = undefined
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    if (this.chatsTimer) clearTimeout(this.chatsTimer)
    this.flushTimer = undefined
    this.reconcileTimer = undefined
    this.chatsTimer = undefined
    this.view = undefined
    this.resolved = undefined
    this.sessionID = undefined
    this.modelChoices = undefined
    this.usage = undefined
    this.chatList = []
    this.running.clear()
    this.runningNow.clear()
    this.waiting.clear()
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
      this.resolved = await resolveClient({
        directory,
        overrideUrl: config.get<string>("serverUrl") ?? "",
        log: (message) => this.log(message),
      })

      const stored = this.context.workspaceState.get<string>(SESSION_KEY)
      if (stored && (await this.sessionExists(stored))) this.sessionID = stored

      if (!this.sessionID) await this.createSession()
      this.disabled = false
      this.subscribe()
      await this.reload()
      await this.refreshChats()
    } catch (error) {
      this.postNotice("error", `Could not connect to OpenCode: ${messageOf(error)}`)
    }
  }

  private directory(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
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
    const agent = (config.get<string>("agent") ?? "").trim()
    const modelRef = this.preferredModel()

    const info = await this.client().session.create({
      title: `Panel · ${folder}`,
      location: { directory: this.directory() },
      ...(agent.length > 0 ? { agent } : {}),
      ...(modelRef ? { model: modelRef } : {}),
    })

    this.sessionID = info.id
    this.sessionTitle = info.title
    await this.context.workspaceState.update(SESSION_KEY, info.id)
    this.log(`Created session ${info.id}`)
    this.sessions?.notifyChanged()
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

  /** Re-read the transcript and the model catalog; the title bar's Refresh. */
  async refresh(): Promise<void> {
    await this.ensureConnected()
    await this.reload()
    await this.refreshChats()
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
      await this.reload()
      this.log(`Switched to chat ${id}`)
    } catch (error) {
      this.postNotice("error", `Could not open that chat: ${describeError(error)}`)
    }
  }

  async pickSession(): Promise<void> {
    try {
      await this.ensureConnected()
      const sessions = await listSessions(this.client(), this.directory(), { limit: 50 })
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

  /** The chats pane's view of this folder: every chat, with what it is doing. */
  private async refreshChats(): Promise<void> {
    if (!this.resolved) return
    try {
      const sessions = await listSessions(this.client(), this.directory(), { limit: 50 })
      const active = this.sessionID
      this.chatList = sessions.map((session) => ({
        id: session.id,
        title: session.title?.trim() || session.id,
        model: modelKey(session.model),
      }))
      if (active && !this.chatList.some((chat) => chat.id === active)) {
        this.chatList.unshift({ id: active, title: this.sessionTitle ?? active, model: "" })
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
    const chats: ChatSummary[] = this.chatList.map((chat) => ({
      id: chat.id,
      title: chat.title,
      model: chat.model,
      busy: this.isRunning(chat.id),
      waiting: this.waiting.get(chat.id)?.size ?? 0,
      active: chat.id === active,
    }))
    if (active && !chats.some((chat) => chat.active)) {
      chats.unshift({
        id: active,
        title: this.sessionTitle ?? active,
        model: "",
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
    return importDefaults(this.client(), this.directory(), (message) => this.log(message))
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
        return {
          key,
          providerID: model.providerID,
          id,
          label: name.length > 0 ? name : key,
        }
      })
  }

  /** Tell the webview which models exist and which one the session is on. */
  private async postSettings(): Promise<void> {
    if (!this.view || !this.resolved) return
    try {
      this.modelChoices = this.modelChoices ?? (await this.loadModels())
    } catch (error) {
      this.log(`Could not list models: ${messageOf(error)}`)
      return
    }

    let current = ""
    if (this.sessionID) {
      try {
        const info = await this.client().session.get({ sessionID: this.sessionID })
        current = modelKey(info.model)
        // The session carries its own running totals; the model is a bonus.
        this.usage = { tokens: toTokenUsage(info.tokens), cost: info.cost ?? 0 }
      } catch (error) {
        this.log(`Could not read the session's model: ${messageOf(error)}`)
      }
    }

    await this.post({ type: "settings", models: this.modelChoices, current, usage: this.usage })
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
        directory,
        agent: defaults.agent,
        model: defaults.model,
      })

      await this.client().session.import(payload as unknown as SessionImportInput)

      this.sessionID = sessionID
      this.sessionTitle = choice.session.title
      await this.context.workspaceState.update(SESSION_KEY, sessionID)
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
        await this.sendPrompt(text)
        return
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
      case "newSession":
        await this.startNewSession()
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

  private async sendPrompt(text: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    if (!this.resolved || !this.sessionID) {
      this.postNotice("error", "Not connected to an OpenCode session yet.")
      return
    }

    const localId = `local-${Date.now()}`
    this.transcript.items.push({ kind: "user", id: localId, text: trimmed })
    this.transcript.busy = true
    this.postReplace()

    try {
      await this.client().session.prompt({ sessionID: this.sessionID, text: trimmed })
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
    this.log(`Directory: ${this.directory()}`)
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
              <button type="button" role="menuitem" data-action="refresh">Refresh</button>
              <div class="menu-sep" role="separator"></div>
              <button type="button" role="menuitem" data-action="importChat">Import from VS Code chat…</button>
              <button type="button" role="menuitem" data-action="backportChat">Send to VS Code chat</button>
              <button type="button" role="menuitem" data-action="openInChat">Open in VS Code Chat</button>
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
        <textarea id="input" rows="3" placeholder="Ask OpenCode…  (Enter to send, Shift+Enter for a new line)"></textarea>
        <div class="composer-row">
          <span id="status" class="status"></span>
          <div class="composer-actions">
            <button id="btn-stop" class="ghost" hidden>Stop</button>
            <button id="send" class="primary">Send</button>
          </div>
        </div>
      </footer>
    </div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`
  }
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
