import type { SessionMessageInfo } from "@opencode/client"
import * as vscode from "vscode"
import { fromMessages } from "./protocol"
import { listSessions, resolveClient } from "./server"

/**
 * OpenCode sessions in the VS Code Chat Sessions view.
 *
 * That view is populated by chat session providers, which is a *proposed* API:
 * VS Code hands it only to extensions listed in its own `product.json`
 * (`extensionEnabledApiProposals`). `scripts/enable-proposed-api.mjs` adds this
 * extension there. Everything below is therefore written defensively - when the
 * API is absent the panel still works, VS Code just shows no OpenCode sessions.
 * Declaring the proposal in `package.json` instead would make VS Code refuse to
 * activate the whole extension, which is why the manifest does not mention it.
 */

/** Scheme for the resources handed to VS Code. This must be unique. */
export const SESSION_SCHEME = "opencode-session"

/** Session type; must match the `chatSessions` contribution in package.json. */
const SESSION_TYPE = "opencode"

/** Chat participant that stands in for these sessions; they are read-only. */
const PARTICIPANT_ID = "opencode.sessions"

/** What VS Code shows for that participant; it normally comes from package.json. */
const PARTICIPANT_PROPS = {
  name: "opencode",
  publisherName: "OpenCode Panel",
  fullName: "OpenCode",
  description: "Sessions from the local OpenCode server",
}

/** `ChatSessionStatus.Completed`. */
const STATUS_COMPLETED = 1

/** How many sessions to offer; matches `opencodePanel.pickSession`. */
const SESSION_LIMIT = 50

type SessionStatus = 0 | 1 | 2 | 3

type ProposedSessionItem = {
  resource: vscode.Uri
  label: string
  description?: string
  status?: SessionStatus
  timing?: { created: number; lastRequestStarted?: number; lastRequestEnded?: number }
}

type ProposedItemController = {
  dispose(): void
  readonly items: { replace(items: readonly ProposedSessionItem[]): void; size: number }
  readonly refreshHandler: (token: vscode.CancellationToken) => Thenable<void>
  createChatSessionItem(resource: vscode.Uri, label: string): ProposedSessionItem
}

type ProposedSession = {
  title?: string
  history: readonly unknown[]
  requestHandler: undefined
}

type ProposedApi = {
  createChatSessionItemController?: (
    chatSessionType: string,
    refreshHandler: (token: vscode.CancellationToken) => Thenable<void>,
  ) => ProposedItemController
  registerChatSessionContentProvider?: (
    scheme: string,
    provider: {
      provideChatSessionContent(resource: vscode.Uri): Thenable<ProposedSession> | ProposedSession
    },
    defaultChatParticipant: vscode.ChatParticipant,
    capabilities?: { supportsInterruptions?: boolean },
  ) => vscode.Disposable
  /**
   * `chatParticipantPrivate`. The static `chat.createChatParticipant` only works
   * for participants declared in `package.json` (VS Code answers "chatParticipant
   * must be declared in package.json" otherwise); this variant registers one on
   * the fly, the way extensions with no declared participants do.
   */
  createDynamicChatParticipant?: (
    id: string,
    props: { name: string; publisherName: string; description?: string; fullName?: string },
    handler: vscode.ChatRequestHandler,
  ) => vscode.ChatParticipant
}

/**
 * Turn classes from the `chatParticipantPrivate` proposal.
 *
 * The stable `ChatRequestTurn`/`ChatResponseTurn` have private constructors, so
 * history for a provider can only be built from these.
 */
type ProposedTurns = {
  ChatRequestTurn2?: new (
    prompt: string,
    command: string | undefined,
    references: readonly unknown[],
    participant: string,
    toolReferences: readonly unknown[],
    editedFileEvents: undefined,
    id: string | undefined,
    modelId: string | undefined,
    modeInstructions: undefined,
  ) => unknown
  ChatResponseTurn2?: new (
    response: readonly unknown[],
    result: unknown,
    participant: string,
  ) => unknown
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function proposedApi(): ProposedApi | undefined {
  const chat = (vscode as unknown as { chat?: Record<string, unknown> }).chat
  if (!chat) return undefined
  if (typeof chat.createChatSessionItemController !== "function") return undefined
  if (typeof chat.registerChatSessionContentProvider !== "function") return undefined
  if (typeof chat.createDynamicChatParticipant !== "function") return undefined
  return chat as ProposedApi
}

function proposedTurns(): ProposedTurns | undefined {
  const module = vscode as unknown as ProposedTurns
  if (typeof module.ChatRequestTurn2 !== "function") return undefined
  if (typeof module.ChatResponseTurn2 !== "function") return undefined
  return module
}

function createdOf(message: SessionMessageInfo): number {
  const time = (message as { time?: { created?: unknown } }).time
  return typeof time?.created === "number" ? time.created : 0
}

type SessionSummary = { id: string; title: string; created: number; updated: number }

export class ChatSessions implements vscode.Disposable {
  private controller: ProposedItemController | undefined

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** True when VS Code let this extension use the proposed session API. */
  get available(): boolean {
    return proposedApi() !== undefined && proposedTurns() !== undefined
  }

  /** Registered during activation; safe to call when the API is unavailable. */
  register(): void {
    const api = proposedApi()
    const turns = proposedTurns()
    const createController = api?.createChatSessionItemController
    const registerContent = api?.registerChatSessionContentProvider
    const createParticipant = api?.createDynamicChatParticipant
    if (!api || !turns || !createController || !registerContent || !createParticipant) {
      this.log(
        "Chat Sessions view disabled: VS Code has not enabled the `chatSessionsProvider` API for this extension. Run `pnpm run enable-proposed-api`, restart VS Code, and reopen the panel.",
      )
      return
    }

    try {
      const participant = createParticipant(PARTICIPANT_ID, PARTICIPANT_PROPS, (_request, _context, stream) => {
        stream.markdown(
          "This OpenCode session is read-only here. Open it in the OpenCode Panel to keep working on it.",
        )
      })
      participant.iconPath = new vscode.ThemeIcon("comment-discussion")

      const controller = createController(SESSION_TYPE, () => this.refresh())
      this.controller = controller

      const contents = registerContent(
        SESSION_SCHEME,
        { provideChatSessionContent: (resource) => this.content(resource) },
        participant,
        { supportsInterruptions: false },
      )

      this.context.subscriptions.push(controller, contents, participant, this)
      this.log("Chat Sessions view registered; OpenCode sessions will appear there")

      // Dev aid: `OPENCODE_PANEL_SELF_CHECK=1` opens the newest session in the
      // chat editor on activation, so the integration can be exercised without
      // clicking through the UI. Documented in the README's Develop section.
      if (process.env.OPENCODE_PANEL_SELF_CHECK === "1") void this.selfCheck()
    } catch (error) {
      this.controller = undefined
      this.log(`Could not register with the Chat Sessions view: ${messageOf(error)}`)
    }
  }

  dispose(): void {
    this.controller = undefined
  }

  /** Re-read the list, for example after the panel created or imported a session. */
  notifyChanged(): void {
    void this.refresh()
  }

  /** Open one session in the editor, the way clicking it in the Sessions view does. */
  async openInChat(sessionID: string): Promise<void> {
    if (!this.available) {
      void vscode.window.showWarningMessage(
        "VS Code has not enabled the OpenCode chat session integration. Run `pnpm run enable-proposed-api` and restart VS Code.",
      )
      return
    }

    try {
      await vscode.commands.executeCommand("vscode.open", this.resourceFor(sessionID))
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not open the session in VS Code Chat: ${messageOf(error)}`)
    }
  }

  // ------------------------------------------------------------------ listing

  /** See `OPENCODE_PANEL_SELF_CHECK` in `register`. */
  private async selfCheck(): Promise<void> {
    try {
      const sessions = await this.list()
      this.log(`Self check: ${sessions.length} session(s) visible to VS Code`)
      if (sessions[0]) await this.openInChat(sessions[0].id)
    } catch (error) {
      this.log(`Self check failed: ${messageOf(error)}`)
    }
  }

  private async refresh(): Promise<void> {
    const controller = this.controller
    if (!controller) return

    try {
      const sessions = await this.list()
      controller.items.replace(sessions.map((session) => this.item(controller, session)))
      this.log(`Listed ${sessions.length} OpenCode session(s) for the Chat Sessions view`)
    } catch (error) {
      this.log(`Could not list sessions for the Chat Sessions view: ${messageOf(error)}`)
      controller.items.replace([])
    }
  }

  private item(controller: ProposedItemController, session: SessionSummary): ProposedSessionItem {
    const item = controller.createChatSessionItem(this.resourceFor(session.id), session.title)
    item.status = STATUS_COMPLETED
    item.timing = {
      created: session.created,
      lastRequestStarted: session.updated,
      lastRequestEnded: session.updated,
    }
    return item
  }

  private async list(): Promise<SessionSummary[]> {
    const resolved = await this.resolve()
    const data = await listSessions(resolved.client, resolved.directory, { limit: SESSION_LIMIT })

    return data
      .filter((session) => session.parentID === undefined) // child (subagent) sessions
      .filter((session) => session.time.archived === undefined)
      .map((session) => ({
        id: session.id,
        title: session.title?.trim() || "OpenCode session",
        created: session.time.created,
        updated: session.time.updated,
      }))
      .sort((left, right) => right.updated - left.updated)
  }

  // ------------------------------------------------------------------ content

  private async content(resource: vscode.Uri): Promise<ProposedSession> {
    const turns = proposedTurns()
    if (!turns) throw new Error("VS Code has not enabled the chat session API for this extension")

    const sessionID = sessionIDOf(resource)
    const resolved = await this.resolve()
    const [info, response] = await Promise.all([
      resolved.client.session.get({ sessionID }),
      resolved.client.message.list({ sessionID }),
    ])

    const messages = [...response.data].sort((left, right) => createdOf(left) - createdOf(right))
    const history = this.history(messages, turns)
    this.log(`Serving ${history.length} turn(s) for ${sessionID} to the chat editor`)
    return {
      title: info.title?.trim() || "OpenCode session",
      history,
      // Read-only: typing here would need the OpenCode server's approval prompts
      // and permission cards to be wired into this stream as well.
      requestHandler: undefined,
    }
  }

  /**
   * The panel's own rendering, as chat turns.
   *
   * Reusing `fromMessages` keeps the text, code fences and tool lines identical
   * to the panel, so the same conversation reads the same in both places.
   */
  private history(messages: readonly SessionMessageInfo[], turns: ProposedTurns): unknown[] {
    const RequestTurn = turns.ChatRequestTurn2
    const ResponseTurn = turns.ChatResponseTurn2
    if (!RequestTurn || !ResponseTurn) return []

    const history: unknown[] = []
    let pending: string[] | undefined

    const flush = (): void => {
      if (!pending) return
      if (pending.length > 0) {
        const parts = pending.map((text) => new vscode.ChatResponseMarkdownPart(text))
        history.push(new ResponseTurn(parts, {}, PARTICIPANT_ID))
      }
      pending = undefined
    }

    for (const item of fromMessages(messages).items) {
      if (item.kind === "user") {
        flush()
        history.push(
          new RequestTurn(item.text, undefined, [], PARTICIPANT_ID, [], undefined, item.id, undefined, undefined),
        )
        pending = []
        continue
      }

      if (item.kind === "assistant") {
        pending = pending ?? []
        for (const block of item.blocks) {
          if (block.type === "text") pending.push(block.text)
          else if (block.type === "tool") {
            const label = block.label.length > 0 ? ` ${block.label}` : ""
            pending.push(`> \`${block.name}\`${label} - ${block.status}`)
          }
        }
        if (item.error) pending.push(`> **Error:** ${item.error}`)
        continue
      }

      if (pending && item.kind === "notice") pending.push(`> ${item.text}`)
      if (pending && item.kind === "permission") {
        pending.push(`> Permission ${item.status}: \`${item.action}\` ${item.resources.join(", ")}`)
      }
    }

    flush()
    return history
  }

  private resourceFor(sessionID: string): vscode.Uri {
    // `scheme://<type>/<key>`, the shape VS Code's own session providers use.
    // The id goes in the path because VS Code lower-cases the authority (it is
    // case-insensitive by spec) and OpenCode session ids are case-sensitive.
    return vscode.Uri.from({ scheme: SESSION_SCHEME, authority: SESSION_TYPE, path: `/${sessionID}` })
  }

  private resolve() {
    const config = vscode.workspace.getConfiguration("opencodePanel")
    return resolveClient({
      directory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
      overrideUrl: config.get<string>("serverUrl") ?? "",
      log: (message) => this.log(message),
    })
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`)
  }
}

/** The session id carried by one of our session resources. */
export function sessionIDOf(resource: vscode.Uri): string {
  return resource.path.replace(/^\//, "")
}
