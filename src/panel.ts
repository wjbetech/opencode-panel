import * as vscode from "vscode"
import type { OpenCodeEvent } from "@opencode/client"
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

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
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

    let modelRef: { providerID: string; id: string } | undefined
    if (model.length > 0) {
      const slash = model.indexOf("/")
      if (slash > 0) {
        modelRef = { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
      } else {
        this.log(`Ignoring opencodePanel.model "${model}": expected provider/model`)
      }
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
      await this.reload()
    } catch (error) {
      this.postNotice("error", messageOf(error))
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
    this.log(`Session: ${this.sessionID ?? "(none)"}`)
    this.log(`Transcript items: ${this.transcript.items.length}`)
    void vscode.window.showInformationMessage(
      `OpenCode Panel: ${this.resolved ? `connected to ${this.resolved.url}` : "not connected"}`,
    )
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
