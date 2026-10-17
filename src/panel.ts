import * as vscode from "vscode"
import type { OpenCodeEvent, SessionImportInput } from "@opencode/client"
import {
  applyEvent,
  emptyTranscript,
  fromMessages,
  mergePermissions,
  permissionItemsFromRequests,
  resolvePermission,
  sessionIDOfEvent,
  type Item,
  type PermissionDecision,
  type Transcript,
} from "./protocol"
import { resolveClient, type ResolvedClient } from "./server"
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

const SESSION_KEY = "opencodePanel.sessionID"
const RECONCILE_DELAY_MS = 300
const PATCH_FLUSH_MS = 40

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

export class PanelController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private transcript: Transcript = emptyTranscript()
  private resolved: ResolvedClient | undefined
  private sessionID: string | undefined
  private sessionTitle: string | undefined
  private events: AbortController | undefined
  private disabled = false

  private readonly pendingItems = new Map<string, Item>()
  private pendingBusy = false
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined

  private readonly output = vscode.window.createOutputChannel("OpenCode Panel")

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(this.output)
  }

  // ---------------------------------------------------------------- lifecycle

  async open(options: { startNew?: boolean } = {}): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside)
      if (options.startNew) await this.startNewSession()
      return
    }

    const panel = vscode.window.createWebviewPanel(
      "opencodePanel",
      "OpenCode Panel",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "dist"),
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
        ],
      },
    )

    this.panel = panel
    panel.webview.html = this.html(panel.webview)
    panel.onDidDispose(() => this.teardown())
    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message)
    })

    await this.connect(options)
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
    this.flushTimer = undefined
    this.reconcileTimer = undefined
    this.panel = undefined
    this.resolved = undefined
    this.sessionID = undefined
  }

  // ------------------------------------------------------------------ session

  private async connect(options: { startNew?: boolean } = {}): Promise<void> {
    try {
      const directory = this.directory()
      const config = vscode.workspace.getConfiguration("opencodePanel")
      this.resolved = await resolveClient({
        directory,
        overrideUrl: config.get<string>("serverUrl") ?? "",
        log: (message) => this.log(message),
      })

      if (!options.startNew) {
        const stored = this.context.workspaceState.get<string>(SESSION_KEY)
        if (stored && (await this.sessionExists(stored))) {
          this.sessionID = stored
        }
      }

      if (!this.sessionID) await this.createSession()
      this.disabled = false
      this.subscribe()
      await this.reload()
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
    const model = (config.get<string>("model") ?? "").trim()
    const modelRef = parseModel(model)

    if (model.length > 0 && !modelRef) {
      this.log(`Ignoring opencodePanel.model "${model}": expected provider/model`)
    }

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
  }

  async startNewSession(): Promise<void> {
    try {
      if (!this.resolved) await this.connect()
      await this.createSession()
      await this.reload()
    } catch (error) {
      this.postNotice("error", messageOf(error))
    }
  }

  async pickSession(): Promise<void> {
    try {
      if (!this.resolved) await this.connect()
      const response = await this.client().session.list({
        directory: this.directory(),
        limit: 50,
        order: "desc",
      })
      const picks = response.data.map((session) => ({
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
        placeHolder: "Pick a session to load in the panel",
      })
      if (!choice) return
      this.sessionID = choice.id
      this.sessionTitle = choice.label
      await this.context.workspaceState.update(SESSION_KEY, choice.id)
      await this.open()
      // The event stream filters on the session captured when it started.
      this.subscribe()
      await this.reload()
    } catch (error) {
      this.postNotice("error", messageOf(error))
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

  /** Pull a VS Code Chat conversation in as a real OpenCode session. */
  async importChatSession(): Promise<void> {
    try {
      if (!this.resolved) await this.connect()

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
        placeHolder: "Pick a chat to bring into the panel",
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

      await this.open()
      this.subscribe()
      await this.reload()
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
      this.postNotice("error", "Open a session in the panel before backporting.")
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
          "Nothing to backport yet - this panel session has no turns. Ask something in the panel first.",
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
        if (choice === "Show Diagnostics") await vscode.commands.executeCommand("opencodePanel.showDiagnostics")
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
    try {
      const response = await this.client().message.list({ sessionID: this.sessionID })
      const messages = [...response.data].sort((left, right) => createdOf(left) - createdOf(right))
      this.transcript = fromMessages(messages)
      await this.syncPermissions()
      this.postReplace()
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
    try {
      const pending = await this.client().permission.list({ sessionID: this.sessionID })
      mergePermissions(this.transcript, permissionItemsFromRequests(pending))
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
    const sessionID = this.sessionID
    if (!client || !sessionID) return

    let attempt = 0
    while (!controller.signal.aborted && attempt < 5) {
      try {
        for await (const event of client.event.subscribe({ signal: controller.signal })) {
          attempt = 0
          if (controller.signal.aborted) break
          this.handleEvent(event, sessionID)
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

  private handleEvent(event: OpenCodeEvent, sessionID: string): void {
    if (sessionIDOfEvent(event) !== sessionID) return

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
        if (this.resolved) void this.reload()
        else this.postReplace()
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
      case "newSession":
        await this.startNewSession()
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
      case "refresh":
        await this.reload()
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
    if (!this.panel) return
    void this.post({
      type: "replace",
      items: this.transcript.items,
      busy: this.transcript.busy,
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
    await this.panel?.webview.postMessage(message)
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`)
  }

  showDiagnostics(): void {
    this.output.show(true)
    this.log(`Server: ${this.resolved?.url ?? "(not connected)"}`)
    this.log(`Directory: ${this.directory()}`)
    this.log(`Session: ${this.sessionID ?? "(not connected)"}`)
    this.log(`Transcript items: ${this.transcript.items.length}`)
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
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"))
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "panel.css"))
    const config = vscode.workspace.getConfiguration("opencodePanel")
    const showReasoning = config.get<boolean>("showReasoning") ?? false

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styles}" />
    <title>OpenCode Panel</title>
  </head>
  <body data-show-reasoning="${showReasoning ? "true" : "false"}">
    <div id="app">
      <header id="top">
        <div class="identity">
          <span class="title">OpenCode</span>
          <span id="session-label" class="session"></span>
        </div>
        <div class="actions">
          <button id="btn-stop" class="ghost" hidden>Stop</button>
          <button id="btn-import" class="ghost" title="Import a conversation from the VS Code Chat view">Import</button>
          <button id="btn-backport" class="ghost" title="Write this session back to VS Code Chat history">Backport</button>
          <button id="btn-refresh" class="ghost">Refresh</button>
          <button id="btn-sessions" class="ghost">Sessions</button>
          <button id="btn-new" class="ghost">New</button>
        </div>
      </header>
      <main id="messages"></main>
      <footer id="composer">
        <textarea id="input" rows="3" placeholder="Ask OpenCode…  (Enter to send, Shift+Enter for a new line)"></textarea>
        <div class="composer-row">
          <span id="status" class="status"></span>
          <button id="send" class="primary">Send</button>
        </div>
      </footer>
    </div>
    <script nonce="${nonce}" src="${script}"></script>
  </body>
</html>`
  }
}

function createNonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let value = ""
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }
  return value
}
