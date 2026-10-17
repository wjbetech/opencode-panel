import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import * as path from "node:path"

/**
 * Bridge to the chat history that VS Code's own Chat view keeps on disk.
 *
 * Nothing here is a public API: VS Code stores sessions as documents and there
 * is no supported way for an extension to read or write them. The layout was
 * verified against VS Code 1.142 and is isolated in this one file so a format
 * change stays a local fix.
 *
 * Layout, per window:
 *   <user>/workspaceStorage/<hash>/workspace.json      which folder this is
 *   <user>/workspaceStorage/<hash>/chatSessions/<id>.json    full snapshot
 *   <user>/workspaceStorage/<hash>/chatSessions/<id>.jsonl   operation log
 *   <user>/workspaceStorage/<hash>/state.vscdb         chat.ChatSessionStore.index
 *
 * The `.jsonl` log is what current versions write: one `{kind: 0, v: <document>}`
 * snapshot followed by `{kind: 1, k: [...], v}` (set) and `{kind: 2, k: [...]}`
 * (append) records that have to be replayed to reach the current state.
 */

// ----------------------------------------------------------------------- types

/** A `#file` reference the user attached to a message in VS Code Chat. */
export type ChatAttachment = {
  readonly path: string
  readonly startLine?: number
  readonly endLine?: number
}

export type ChatTurn = {
  readonly timestamp: number
  readonly modelId: string
  readonly user: string
  readonly attachments: readonly ChatAttachment[]
  /** The assistant's answer as markdown. Empty when the request produced none. */
  readonly assistant: string
}

export type VscodeChatSession = {
  /** Absolute path of the file this came from. */
  readonly file: string
  readonly sessionId: string
  /** Absolute folder the chat belongs to; empty when the workspace file is missing. */
  readonly folder: string
  readonly title: string
  readonly creationDate: number
  readonly lastMessageDate: number
  readonly turns: readonly ChatTurn[]
}

export type OpenCodeModel = { readonly id: string; readonly providerID: string; readonly variant?: string }

/** The payload `session.import` expects, mirroring what `session.export` returns. */
export type ImportPayload = {
  info: Record<string, unknown>
  messages: Record<string, unknown>[]
  location: { directory: string }
  /** Turns folded into the leading summary because they did not fit. */
  summarisedTurns: number
}

export type ImportOptions = {
  readonly sessionID: string
  readonly projectID: string
  readonly directory: string
  readonly agent?: string
  readonly model?: OpenCodeModel
  /** Unix ms to stamp as the session creation time. Defaults to the chat's. */
  readonly createdAt?: number
}

// ------------------------------------------------------------------- defaults

/** The part of the client the default lookups need. */
export type CatalogClient = {
  agent: { list: () => Promise<{ data: CatalogAgent[] } | CatalogAgent[]> }
  model: { list: () => Promise<{ data: CatalogModel[] } | CatalogModel[]> }
  session: { list: (input: { directory: string; limit: number }) => Promise<{ data: CatalogSession[] }> }
}

type CatalogAgent = {
  id: string
  mode?: string
  hidden?: boolean
  model?: { id: string; providerID: string; variant?: string }
}

type CatalogModel = {
  id: string
  modelID?: string
  providerID: string
  enabled?: boolean
  status?: string
}

type CatalogSession = {
  projectID: string
  agent?: string
  model?: OpenCodeModel
}

export type ImportDefaults = { projectID: string; agent: string; model: OpenCodeModel }

function listOf<T>(value: { data: T[] } | T[]): T[] {
  return Array.isArray(value) ? value : value.data
}

function modelOf(name: CatalogModel): OpenCodeModel {
  const id = typeof name.modelID === "string" && name.modelID.length > 0 ? name.modelID : name.id
  return { id, providerID: name.providerID }
}

/**
 * The defaults a new session would run with: the primary agent, and the model
 * that agent prefers (or the first active model the server offers).
 */
export async function catalogDefaults(client: CatalogClient): Promise<Omit<ImportDefaults, "projectID">> {
  const agents = listOf(await client.agent.list())
  const agent = agents.find((entry) => entry.mode === "primary" && entry.hidden !== true) ?? agents[0]
  if (!agent) throw new Error("The server reported no agents to attribute imported work to")

  if (agent.model) {
    const preferred: OpenCodeModel = { id: agent.model.id, providerID: agent.model.providerID }
    return {
      agent: agent.id,
      model: agent.model.variant === undefined ? preferred : { ...preferred, variant: agent.model.variant },
    }
  }

  const models = listOf(await client.model.list())
  const model =
    models.find((entry) => entry.enabled && entry.status === "active") ??
    models.find((entry) => entry.enabled) ??
    models[0]
  if (!model) throw new Error("The server reported no models to attribute imported work to")

  return { agent: agent.id, model: modelOf(model) }
}

/**
 * Agent, model and project for an imported session.
 *
 * Imported assistant messages have to name an agent and a model the server can
 * resolve, and a directory with no history offers neither, so this falls back
 * to the server's own catalogs. A blank project id is fine: the server files
 * the session under the project for `location.directory`.
 */
export async function importDefaults(
  client: CatalogClient,
  directory: string,
  log: (message: string) => void = () => {},
): Promise<ImportDefaults> {
  try {
    const existing = await client.session.list({ directory, limit: 10 })
    const seed = existing.data.find(
      (session) => session.agent !== undefined && session.model !== undefined,
    )
    if (seed?.agent !== undefined && seed.model !== undefined) {
      return { projectID: seed.projectID, agent: seed.agent, model: seed.model }
    }
    const first = existing.data[0]
    if (first) {
      const catalog = await catalogDefaults(client)
      return {
        projectID: first.projectID,
        agent: first.agent ?? catalog.agent,
        model: first.model ?? catalog.model,
      }
    }
  } catch (error) {
    log(`Could not read import defaults from existing sessions: ${error instanceof Error ? error.message : String(error)}`)
  }

  const catalog = await catalogDefaults(client)
  return { projectID: "", agent: catalog.agent, model: catalog.model }
}

// ------------------------------------------------------------------------ ids

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function randomSuffix(length: number): string {
  const bytes = randomBytes(length)
  let out = ""
  for (const byte of bytes) out += BASE62.charAt(byte % BASE62.length)
  return out
}

/**
 * Ids in the shape the server makes them (`ses_` + 26 base62 characters).
 *
 * `session.import` creates the session under the id it is given and refuses to
 * overwrite an existing one, so the caller has to supply a fresh id rather than
 * letting `session.create` pick one.
 */
export function newSessionID(): string {
  return `ses_${randomSuffix(26)}`
}

export function newMessageID(): string {
  return `msg_${randomSuffix(26)}`
}

// ---------------------------------------------------------------- paths/uris

/** `file:///c%3A/Users/Will/Coding/app` -> `c:\Users\Will\Coding\app`. */
export function decodeFolder(uri: string): string {
  let decoded = uri.replace(/^file:\/\//i, "")
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // Leave it as-is; a malformed escape is not worth failing the whole scan.
  }
  if (process.platform === "win32") {
    decoded = decoded.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\")
  }
  return decoded
}

/** Compare two folder paths the way the file system does on this platform. */
export function sameFolder(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) return false
  const normalize = (value: string): string => {
    const slashed = value.replace(/[\\/]+/g, "/").replace(/\/+$/, "")
    return process.platform === "win32" ? slashed.toLowerCase() : slashed
  }
  return normalize(left) === normalize(right)
}

/** `<user>` from the extension's global storage, e.g. `%APPDATA%/Code/User`. */
export function userRootFromGlobalStorage(globalStoragePath: string): string {
  return path.dirname(path.dirname(globalStoragePath))
}

export function chatStoreRoot(userRoot: string): string {
  return path.join(userRoot, "workspaceStorage")
}

function readWorkspaceFolder(workspaceDir: string): string {
  try {
    const raw = readFileSync(path.join(workspaceDir, "workspace.json"), "utf8")
    const parsed = JSON.parse(raw) as { folder?: unknown; workspace?: unknown }
    const value = parsed.folder ?? parsed.workspace
    return typeof value === "string" ? decodeFolder(value) : ""
  } catch {
    return ""
  }
}

/** The workspace storage directory VS Code uses for `folder`, if it exists. */
export function findWorkspaceDir(storeRoot: string, folder: string): string | undefined {
  let entries: string[]
  try {
    entries = readdirSync(storeRoot)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const dir = path.join(storeRoot, entry)
    if (sameFolder(readWorkspaceFolder(dir), folder)) return dir
  }
  return undefined
}

// --------------------------------------------------------------------- reading

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Replay an operation log into the session document it describes.
 *
 * `kind: 0` is the opening snapshot; `kind: 1` sets the value at key path `k`;
 * `kind: 2` appends to the array at key path `k`. Verified against sessions that
 * exist in both formats: the request ids and per-request response counts match.
 */
export function decodeLog(raw: string): Record<string, unknown> {
  let root: Record<string, unknown> = {}

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!isRecord(parsed)) continue
      record = parsed
    } catch {
      continue
    }

    if (record.kind === 0 && isRecord(record.v)) {
      root = record.v
      continue
    }

    const keyPath = record.k
    if (!Array.isArray(keyPath) || keyPath.length === 0) continue

    let node: Record<string, unknown> = root
    for (let index = 0; index < keyPath.length - 1; index += 1) {
      const key = keyPath[index]
      if (typeof key !== "string" && typeof key !== "number") break
      const existing = node[String(key)]
      if (!isRecord(existing) && !Array.isArray(existing)) {
        const next = keyPath[index + 1]
        const created: unknown = typeof next === "number" ? [] : {}
        node[String(key)] = created
      }
      const next = node[String(key)]
      if (!isRecord(next) && !Array.isArray(next)) break
      node = next as Record<string, unknown>
    }

    const last = keyPath[keyPath.length - 1]
    if (typeof last !== "string" && typeof last !== "number") continue
    const key = String(last)

    if (record.kind === 2) {
      const target = node[key]
      const list = Array.isArray(target) ? target : []
      list.push(...(Array.isArray(record.v) ? record.v : [record.v]))
      node[key] = list
    } else {
      node[key] = record.v
    }
  }

  return root
}

function readDocument(file: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(file, "utf8")
    const document = file.endsWith(".jsonl") ? decodeLog(raw) : (JSON.parse(raw) as unknown)
    return isRecord(document) ? document : undefined
  } catch {
    return undefined
  }
}

/** Text of the user's turn, falling back to the typed parts. */
function userTextOf(request: Record<string, unknown>): string {
  const message = request.message
  if (isRecord(message)) {
    if (typeof message.text === "string" && message.text.trim().length > 0) return message.text
    const parts = message.parts
    if (Array.isArray(parts)) {
      const pieces: string[] = []
      for (const part of parts) {
        if (isRecord(part) && typeof part.text === "string") pieces.push(part.text)
      }
      if (pieces.length > 0) return pieces.join("")
    }
  }
  return ""
}

function attachmentsOf(request: Record<string, unknown>): ChatAttachment[] {
  const variables = (request.variableData as { variables?: unknown } | undefined)?.variables
  if (!Array.isArray(variables)) return []

  const attachments: ChatAttachment[] = []
  for (const variable of variables) {
    if (!isRecord(variable) || variable.kind !== "file") continue
    const value = variable.value
    if (!isRecord(value)) continue

    const uri = value.uri
    let filePath = ""
    if (isRecord(uri)) {
      if (typeof uri.fsPath === "string") filePath = uri.fsPath
      else if (typeof uri.path === "string") filePath = decodeFolder(`file://${uri.path}`)
      else if (typeof uri.external === "string") filePath = decodeFolder(uri.external)
    } else if (typeof uri === "string") {
      filePath = decodeFolder(uri)
    }
    if (filePath.length === 0) continue

    const range = value.range
    if (isRecord(range) && typeof range.startLineNumber === "number" && typeof range.endLineNumber === "number") {
      attachments.push({ path: filePath, startLine: range.startLineNumber, endLine: range.endLineNumber })
    } else {
      attachments.push({ path: filePath })
    }
  }
  return attachments
}

/**
 * Flatten VS Code's response stream into markdown.
 *
 * The array mixes prose, reasoning, tool chatter and edit bookkeeping. Only the
 * prose survives verbatim; tools become a one-line note so the reading order is
 * still clear. Reasoning and edit bookkeeping are dropped.
 */
export function responseToMarkdown(response: unknown): string {
  if (!Array.isArray(response)) return ""

  const chunks: string[] = []
  for (const entry of response) {
    if (typeof entry === "string") {
      chunks.push(entry)
      continue
    }
    if (!isRecord(entry)) continue

    const kind = entry.kind
    if (kind === undefined) {
      if (typeof entry.value === "string") chunks.push(entry.value)
      continue
    }

    if (kind === "toolInvocationSerialized") {
      const invocation = entry.invocationMessage
      const label = isRecord(invocation) && typeof invocation.value === "string" ? invocation.value : ""
      const tool = typeof entry.toolId === "string" ? entry.toolId : ""
      const text = label.trim().length > 0 ? label.trim() : tool
      if (text.length > 0) chunks.push(`\n> ↳ ${text}\n`)
      continue
    }

    if (kind === "textEditGroup") {
      const uri = entry.uri
      const target =
        isRecord(uri) && typeof uri.fsPath === "string"
          ? uri.fsPath
          : isRecord(uri) && typeof uri.path === "string"
            ? uri.path
            : ""
      if (target.length > 0) chunks.push(`\n> ✎ edits in ${target}\n`)
      continue
    }

    // thinking, mcpServersStarting, prepareToolInvocation, undoStop,
    // codeblockUri, inlineReference, progressTaskSerialized, confirmation,
    // elicitationSerialized: presentation details with nothing to carry over.
  }

  return chunks.join("").trim()
}

/** Map a session document onto the shape the panel works with. */
export function toChatSession(file: string, folder: string, document: Record<string, unknown>): VscodeChatSession {
  const requests = Array.isArray(document.requests) ? document.requests : []
  const turns: ChatTurn[] = []

  for (const request of requests) {
    if (!isRecord(request)) continue
    const user = userTextOf(request).replace(/\r\n/g, "\n")
    const assistant = responseToMarkdown(request.response)
    if (user.trim().length === 0 && assistant.length === 0) continue

    turns.push({
      timestamp: typeof request.timestamp === "number" ? request.timestamp : 0,
      modelId: typeof request.modelId === "string" ? request.modelId : "",
      user,
      attachments: attachmentsOf(request),
      assistant,
    })
  }

  const firstUser = turns.find((turn) => turn.user.trim().length > 0)
  const customTitle = typeof document.customTitle === "string" ? document.customTitle.trim() : ""
  const derived = (firstUser?.user ?? "").trim().split("\n")[0] ?? ""
  const title = customTitle.length > 0 ? customTitle : derived.slice(0, 90)

  const creationDate = typeof document.creationDate === "number" ? document.creationDate : 0
  const lastMessageDate = turns.reduce(
    (latest, turn) => (turn.timestamp > latest ? turn.timestamp : latest),
    creationDate,
  )
  const sessionId =
    typeof document.sessionId === "string" && document.sessionId.length > 0
      ? document.sessionId
      : path.basename(file).replace(/\.jsonl?$/, "")

  return { file, sessionId, folder, title: title.length > 0 ? title : "(untitled chat)", creationDate, lastMessageDate, turns }
}

/** Parsed sessions, keyed by file and invalidated by size + mtime. */
const sessionCache = new Map<string, { stamp: string; session: VscodeChatSession }>()

export function readChatSession(file: string, folder?: string): VscodeChatSession | undefined {
  let stamp = ""
  try {
    const stats = statSync(file)
    stamp = `${stats.size}:${stats.mtimeMs}`
  } catch {
    return undefined
  }

  const cached = sessionCache.get(file)
  if (cached && cached.stamp === stamp) return cached.session

  const document = readDocument(file)
  if (!document) return undefined
  const resolvedFolder = folder ?? readWorkspaceFolder(path.dirname(path.dirname(file)))
  const session = toChatSession(file, resolvedFolder, document)
  sessionCache.set(file, { stamp, session })
  return session
}

/** Every chat session VS Code has on disk, newest first. */
export function listChatSessions(storeRoot: string): VscodeChatSession[] {
  let workspaceDirs: string[]
  try {
    workspaceDirs = readdirSync(storeRoot)
  } catch {
    return []
  }

  const sessions: VscodeChatSession[] = []
  for (const entry of workspaceDirs) {
    const workspaceDir = path.join(storeRoot, entry)
    const sessionsDir = path.join(workspaceDir, "chatSessions")
    if (!existsSync(sessionsDir)) continue
    const folder = readWorkspaceFolder(workspaceDir)

    let files: string[]
    try {
      files = readdirSync(sessionsDir)
    } catch {
      continue
    }

    for (const name of files) {
      if (!name.endsWith(".json") && !name.endsWith(".jsonl")) continue
      const session = readChatSession(path.join(sessionsDir, name), folder)
      if (session) sessions.push(session)
    }
  }

  return sessions.sort((left, right) => right.lastMessageDate - left.lastMessageDate)
}

// ------------------------------------------------------- VS Code -> OpenCode

function attachmentFooter(attachments: readonly ChatAttachment[]): string {
  if (attachments.length === 0) return ""
  const parts = attachments.map((attachment) => {
    const name = attachment.path.replace(/\\/g, "/")
    if (attachment.startLine === undefined || attachment.endLine === undefined) return `\`${name}\``
    return `\`${name}\` L${attachment.startLine}–${attachment.endLine}`
  })
  return `\n\nContext: ${parts.join(", ")}`
}

function attachmentFileEntries(attachments: readonly ChatAttachment[]): Record<string, unknown>[] {
  return attachments.map((attachment) => {
    const normalized = attachment.path.replace(/\\/g, "/")
    const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`
    return {
      data: "",
      mime: "text/plain",
      source: { type: "uri", uri: `file://${encodeURI(prefixed)}` },
      name: path.basename(attachment.path),
    }
  })
}

/**
 * `session.import` stores at most 50 messages and keeps the newest ones: a
 * 743-message payload came back as the last 50. Staying under the cap keeps the
 * payload intact, and the turns that do not fit are summarised into the first
 * message instead of being silently dropped.
 */
export const IMPORT_MESSAGE_LIMIT = 50

/** What a turn will cost once it becomes messages. */
function messageCount(turn: ChatTurn): number {
  const user = turn.user.trim().length > 0 || turn.attachments.length > 0 ? 1 : 0
  const assistant = turn.assistant.length > 0 ? 1 : 0
  return user + assistant
}

const DIGEST_MAX_QUESTIONS = 50
const DIGEST_MAX_CHARS = 8000

/** A short list of the questions from turns that did not fit, newest last. */
export function digestOf(turns: readonly ChatTurn[], from: number, to: number): string {
  const questions: string[] = []
  for (let index = from; index < to; index += 1) {
    const turn = turns[index]
    if (!turn) continue
    const question = (turn.user.trim().split("\n")[0] ?? "").trim().slice(0, 160)
    if (question.length > 0) questions.push(question)
  }
  if (questions.length === 0) return ""

  const chosen: string[] = []
  if (questions.length <= DIGEST_MAX_QUESTIONS) {
    chosen.push(...questions)
  } else {
    const half = Math.floor(DIGEST_MAX_QUESTIONS / 2)
    const head = questions.slice(0, half)
    const tail = questions.slice(-half)
    chosen.push(...head, `… ${questions.length - head.length - tail.length} turns omitted …`, ...tail)
  }

  // Drop from the middle while the digest is still too long: the opening and the
  // most recent questions are the ones worth keeping.
  while (chosen.join("\n").length > DIGEST_MAX_CHARS && chosen.length > 4) {
    chosen.splice(Math.floor(chosen.length / 2), 1)
  }

  const header = `Earlier turns from this conversation, before the part below (${to - from} turns, summarised because a session import holds at most ${IMPORT_MESSAGE_LIMIT} messages):`
  return `${header}\n${chosen.map((line) => `- ${line}`).join("\n")}`
}

/**
 * Turn a VS Code chat into the payload `session.import` accepts.
 *
 * Each request becomes a real user/assistant pair, so the model reads the
 * earlier work as its own history rather than as a summary somebody pasted in.
 */
export function toOpenCodeImport(session: VscodeChatSession, options: ImportOptions): ImportPayload {
  const timestamp = options.createdAt ?? (session.creationDate > 0 ? session.creationDate : Date.now())
  let cursor = timestamp

  // Keep the newest turns that fit, leaving room for the summary and the
  // trailing idle marker.
  const budget = IMPORT_MESSAGE_LIMIT - 2
  const kept: ChatTurn[] = []
  let used = 0
  for (let index = session.turns.length - 1; index >= 0; index -= 1) {
    const turn = session.turns[index]
    if (!turn) continue
    const size = messageCount(turn)
    if (used + size > budget) break
    kept.unshift(turn)
    used += size
  }
  const dropped = session.turns.length - kept.length
  const digest = dropped > 0 ? digestOf(session.turns, 0, dropped) : ""

  const messages: Record<string, unknown>[] = []

  if (digest.length > 0) {
    messages.push({
      id: newMessageID(),
      time: { created: timestamp },
      text: digest,
      files: [],
      agents: [],
      type: "user",
    })
  }

  for (const turn of kept) {
    const at = turn.timestamp > 0 ? turn.timestamp : cursor
    cursor = at + 1

    if (turn.user.trim().length > 0 || turn.attachments.length > 0) {
      messages.push({
        id: newMessageID(),
        time: { created: at },
        text: `${turn.user}${attachmentFooter(turn.attachments)}`.trim(),
        files: attachmentFileEntries(turn.attachments),
        agents: [],
        type: "user",
      })
    }

    if (turn.assistant.length > 0) {
      messages.push({
        id: newMessageID(),
        time: { created: at + 1, streamed: at + 1, completed: at + 1 },
        type: "assistant",
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(options.model === undefined ? {} : { model: options.model }),
        content: [{ type: "text", text: turn.assistant }],
      })
    }
  }

  const last = messages.length > 0 ? cursor : timestamp
  messages.push({ id: newMessageID(), time: { created: last + 1 }, type: "idle", outcome: "succeeded" })

  const info: Record<string, unknown> = {
    id: options.sessionID,
    projectID: options.projectID,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.model === undefined ? {} : { model: options.model }),
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: timestamp, updated: last },
    title: session.title,
    location: { directory: options.directory },
  }

  return { info, messages, location: { directory: options.directory }, summarisedTurns: digest.length > 0 ? dropped : 0 }
}

// ------------------------------------------------------- OpenCode -> VS Code

export type BackportOptions = {
  readonly folder: string
  /** Name VS Code shows as the responder. */
  readonly responder?: string
  readonly modelId?: string
  readonly title?: string
}

function textOfAssistant(message: Record<string, unknown>): string {
  const content = message.content
  if (!Array.isArray(content)) return ""
  const pieces: string[] = []
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") pieces.push(part.text)
  }
  return pieces.join("").trim()
}

/**
 * Turn an exported OpenCode session into a document VS Code's Chat view renders.
 *
 * The response stream only needs markdown entries: code fences render with the
 * usual copy affordances, and nothing is applied to the workspace, which matches
 * how the panel wants snippets handled.
 */
export function fromOpenCodeExport(
  exported: { info?: unknown; messages?: unknown },
  options: BackportOptions,
): {
  document: Record<string, unknown>
  sessionId: string
  indexEntry: Record<string, unknown>
  turnCount: number
} {
  const info = isRecord(exported.info) ? exported.info : {}
  const messages = Array.isArray(exported.messages) ? exported.messages : []

  const sessionId = typeof info.id === "string" && info.id.length > 0 ? info.id : `ses_${randomSuffix(26)}`
  // VS Code keys its history with a UUID, so keep the OpenCode id as the title
  // anchor and hand VS Code a UUID of its own.
  const vscodeSessionID = randomUuid()

  const turns: { user: string; assistant: string; timestamp: number }[] = []
  let pendingUser = ""
  let pendingAt = 0

  for (const message of messages) {
    if (!isRecord(message)) continue
    const created = isRecord(message.time) && typeof message.time.created === "number" ? message.time.created : 0

    if (message.type === "user" && typeof message.text === "string") {
      pendingUser = message.text
      pendingAt = created
      continue
    }

    if (message.type === "assistant") {
      const assistant = textOfAssistant(message)
      if (pendingUser.trim().length > 0 || assistant.length > 0) {
        turns.push({ user: pendingUser, assistant, timestamp: pendingAt || created })
      }
      pendingUser = ""
      pendingAt = 0
    }
  }

  // A trailing user turn with no answer still belongs in the transcript.
  if (pendingUser.trim().length > 0) {
    turns.push({ user: pendingUser, assistant: "", timestamp: pendingAt })
  }

  const modelId = options.modelId ?? modelIdOf(info) ?? "opencode"
  const infoTitle = typeof info.title === "string" ? info.title.trim() : ""
  const firstUser = (turns.find((turn) => turn.user.trim().length > 0)?.user ?? "").trim()
  const derivedTitle = firstUser.split("\n")[0]?.slice(0, 90) ?? ""
  const title = options.title ?? (infoTitle.length > 0 ? infoTitle : derivedTitle.length > 0 ? derivedTitle : "OpenCode session")

  const baseUri = { scheme: "file", path: options.folder.replace(/\\/g, "/") }

  const requests = turns.map((turn) => ({
    requestId: `request_${randomUuid()}`,
    message: {
      text: turn.user,
      parts: [{ kind: "text", text: turn.user }],
    },
    variableData: { variables: [] },
    response: [{ value: turn.assistant, supportThemeIcons: false, supportHtml: false, baseUri }],
    agent: {
      extensionId: { value: "local.opencode-panel", _lower: "local.opencode-panel" },
      extensionDisplayName: "OpenCode Panel",
      publisherDisplayName: "local",
      id: "opencode.panel",
      name: "OpenCode",
      fullName: "OpenCode",
      description: "OpenCode sessions, backported from the OpenCode Panel",
      isDefault: false,
      locations: [],
      modes: [],
      slashCommands: [],
    },
    timestamp: turn.timestamp || Date.now(),
    modelId,
    responseId: `response_${randomUuid()}`,
    result: {},
    followups: [],
    modelState: { value: 3, completedAt: turn.timestamp || Date.now() },
    contentReferences: [],
    codeCitations: [],
    timeSpentWaiting: 0,
  }))

  const infoTime = isRecord(info.time) ? info.time : {}
  const creationDate = typeof infoTime.created === "number" ? infoTime.created : Date.now()
  const lastMessageDate = turns.reduce((latest, turn) => (turn.timestamp > latest ? turn.timestamp : latest), creationDate)

  const document: Record<string, unknown> = {
    version: 3,
    sessionId: vscodeSessionID,
    creationDate,
    lastMessageDate,
    customTitle: title,
    initialLocation: "panel",
    responderUsername: options.responder ?? "OpenCode",
    responderAvatarIconUri: { id: "opencode" },
    hasPendingEdits: false,
    inputState: {
      contrib: { chatDynamicVariableModel: [] },
      attachments: [],
      mode: { id: "agent", kind: "agent" },
      selectedModel: {
        identifier: modelId,
        metadata: { id: modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId, name: modelId },
      },
    },
    requests,
  }

  const indexEntry: Record<string, unknown> = {
    sessionId: vscodeSessionID,
    title,
    lastMessageDate,
    timing: { created: creationDate, lastRequestStarted: lastMessageDate, lastRequestEnded: lastMessageDate },
    initialLocation: "panel",
    hasPendingEdits: false,
    isEmpty: requests.length === 0,
    isExternal: false,
    lastResponseState: 1,
    permissionLevel: "default",
  }

  return { document, sessionId: vscodeSessionID, indexEntry, turnCount: turns.length }
}

function modelIdOf(info: Record<string, unknown>): string | undefined {
  const model = info.model
  if (!isRecord(model)) return undefined
  const providerID = typeof model.providerID === "string" ? model.providerID : ""
  const id = typeof model.id === "string" ? model.id : ""
  if (id.length === 0) return undefined
  return providerID.length > 0 ? `${providerID}/${id}` : id
}

function randomUuid(): string {
  const bytes = randomBytes(16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// --------------------------------------------------------------------- writing

/**
 * Write the session as a one-record operation log, the format current builds
 * read (older sessions in `chatSessions` use a plain `.json` snapshot).
 */
export function writeChatSession(workspaceDir: string, sessionId: string, document: Record<string, unknown>): string {
  const sessionsDir = path.join(workspaceDir, "chatSessions")
  mkdirSync(sessionsDir, { recursive: true })
  const file = path.join(sessionsDir, `${sessionId}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ kind: 0, v: document })}\n`, "utf8")
  return file
}

type SqliteRow = { value?: unknown }

/**
 * Add the session to `chat.ChatSessionStore.index`.
 *
 * The history list reads that index rather than scanning `chatSessions`, so a
 * file on its own stays invisible. This writes into VS Code's own state
 * database, which is the unsupported part of the feature: it is best-effort and
 * failures are reported rather than thrown, because VS Code may hold a cached
 * copy that overwrites the entry anyway.
 */
export async function updateChatIndex(
  workspaceDir: string,
  sessionId: string,
  entry: Record<string, unknown>,
): Promise<{ updated: boolean; reason?: string }> {
  const dbPath = path.join(workspaceDir, "state.vscdb")
  if (!existsSync(dbPath)) return { updated: false, reason: "state.vscdb not found" }

  let DatabaseSync: new (file: string) => {
    exec: (sql: string) => void
    prepare: (sql: string) => { get: (...params: unknown[]) => SqliteRow | undefined; run: (...params: unknown[]) => unknown }
    close: () => void
  }

  try {
    const sqlite = (await import("node:sqlite")) as unknown as { DatabaseSync: typeof DatabaseSync }
    DatabaseSync = sqlite.DatabaseSync
  } catch {
    return { updated: false, reason: "node:sqlite is unavailable in this runtime" }
  }

  // VS Code holds this database open, so a write can land on a locked file.
  let lastError = ""
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
    try {
      const db = new DatabaseSync(dbPath)
      // Wait for VS Code to release the lock rather than failing outright.
      db.exec("PRAGMA busy_timeout = 5000")
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'").get()
      const index: { version?: number; entries?: Record<string, unknown> } =
        typeof row?.value === "string" ? JSON.parse(row.value) : { version: 1, entries: {} }
      index.version = index.version ?? 1
      index.entries = index.entries ?? {}
      index.entries[sessionId] = entry
      db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(
        "chat.ChatSessionStore.index",
        JSON.stringify(index),
      )
      // Read it back so a silently-dropped write is reported rather than assumed.
      const written = db.prepare("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'").get()
      db.close()
      const hasEntry =
        typeof written?.value === "string" && written.value.includes(sessionId)
      return hasEntry
        ? { updated: true }
        : { updated: false, reason: "the index write did not stick" }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { updated: false, reason: lastError }
}
