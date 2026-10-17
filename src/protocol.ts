import type { OpenCodeEvent, PermissionRequest, SessionMessageInfo } from "@opencode/client"

/**
 * Render model shared by the extension host and the webview.
 *
 * Everything the panel shows is derived from these plain objects, so the same
 * mapping code can run against server history (`fromMessages`) and against the
 * live event stream (`applyEvent`).
 */

export type TextBlock = { type: "text"; segment: number; text: string }
export type ReasoningBlock = { type: "reasoning"; segment: number; text: string }
export type ToolBlock = {
  type: "tool"
  id: string
  name: string
  status: "running" | "done" | "error"
  label: string
  detail?: string
}
export type Block = TextBlock | ReasoningBlock | ToolBlock

export type UserItem = { kind: "user"; id: string; text: string }
export type AssistantItem = {
  kind: "assistant"
  id: string
  blocks: Block[]
  streaming: boolean
  error?: string
}
export type NoticeItem = { kind: "notice"; id: string; level: "info" | "error"; text: string }

/** What the user answered; `pending` until they do. */
export type PermissionDecision = "once" | "always" | "reject"

/**
 * A tool that the server will not run without an explicit answer.
 *
 * Verified payload (server 2.0.32, reading a `.env` file):
 * `{ id: "per_…", action: "read", resources: [".env"], save: ["*"],
 *    source: { type: "tool", messageID: "msg_…", id: "call-…" } }`
 *
 * `permission.list()` returns pending requests only, so a reload can safely
 * re-merge whatever it finds without resurrecting answered ones.
 */
export type PermissionItem = {
  kind: "permission"
  id: string
  action: string
  resources: string[]
  save: string[]
  message?: string
  status: "pending" | PermissionDecision
}

export type Item = UserItem | AssistantItem | NoticeItem | PermissionItem

export type Transcript = { items: Item[]; busy: boolean }

/** One selectable model, flattened from the server's catalog for the picker. */
export type ModelChoice = {
  /** `providerID/id`, also the option value. */
  key: string
  providerID: string
  id: string
  /** Human-facing name; the id is kept for the tooltip. */
  label: string
}

export type SessionSettings = {
  models: ModelChoice[]
  /** `providerID/id` of the model this session runs with, or "" when unknown. */
  current: string
}

/** `providerID/id` for a model reference, matching `ModelChoice.key`. */
export function modelKey(model: { id?: string; providerID?: string } | undefined): string {
  if (!model || typeof model.id !== "string" || model.id.length === 0) return ""
  const provider = typeof model.providerID === "string" ? model.providerID : ""
  return provider.length > 0 ? `${provider}/${model.id}` : model.id
}

export type ApplyResult = { changed: boolean; itemID?: string }

export function emptyTranscript(): Transcript {
  return { items: [], busy: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Keys that usually hold the human-meaningful part of a tool call's input. */
const LABEL_KEYS = [
  "description",
  "filePath",
  "path",
  "pattern",
  "command",
  "query",
  "url",
  "prompt",
  "glob",
]

export function toolLabel(input: unknown): string {
  if (!isRecord(input)) return ""
  for (const key of LABEL_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value.trim().length > 0) {
      const first = value.trim().split("\n")[0] ?? ""
      return first.slice(0, 140)
    }
  }
  return ""
}

function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const entry of content) {
    if (!isRecord(entry)) continue
    if (typeof entry.text === "string") parts.push(entry.text)
    else if (typeof entry.uri === "string") parts.push(entry.uri)
  }
  const joined = parts.join("\n").trim()
  if (joined.length === 0) return undefined
  const limit = 6000
  return joined.length > limit ? `${joined.slice(0, limit)}\n… (truncated)` : joined
}

/** Map stored session history onto the render model. */
export function fromMessages(messages: readonly SessionMessageInfo[]): Transcript {
  const transcript = emptyTranscript()

  for (const message of messages) {
    if (message.type === "user") {
      transcript.items.push({ kind: "user", id: message.id, text: message.text })
      continue
    }

    if (message.type === "assistant") {
      const item: AssistantItem = {
        kind: "assistant",
        id: message.id,
        blocks: [],
        streaming: false,
      }

      message.content.forEach((part, index) => {
        if (part.type === "text") {
          item.blocks.push({ type: "text", segment: index, text: part.text })
          return
        }
        if (part.type === "reasoning") {
          item.blocks.push({ type: "reasoning", segment: index, text: part.text })
          return
        }
        if (part.type === "tool") {
          const state = part.state
          const status =
            state.status === "completed" ? "done" : state.status === "error" ? "error" : "running"
          const detail =
            state.status === "completed" || state.status === "error"
              ? contentText(state.content)
              : undefined
          item.blocks.push({
            type: "tool",
            id: part.id,
            name: part.name,
            status,
            label: toolLabel(state.input),
            ...(detail === undefined ? {} : { detail }),
          })
        }
      })

      if (message.error) item.error = message.error.message
      transcript.items.push(item)
      continue
    }

    if (message.type === "idle" && message.outcome === "failed" && message.error) {
      transcript.items.push({
        kind: "notice",
        id: `notice-${message.id}`,
        level: "error",
        text: message.error.message,
      })
    }
  }

  return transcript
}

function ensureAssistant(transcript: Transcript, id: string): AssistantItem {
  for (const item of transcript.items) {
    if (item.kind === "assistant" && item.id === id) {
      item.streaming = true
      return item
    }
  }
  const created: AssistantItem = { kind: "assistant", id, blocks: [], streaming: true }
  transcript.items.push(created)
  return created
}

function appendSegment(blocks: Block[], type: "text" | "reasoning", segment: number, delta: string): void {
  const last = blocks[blocks.length - 1]
  if (last && last.type === type && last.segment === segment) {
    last.text += delta
    return
  }
  blocks.push({ type, segment, text: delta })
}

function findTool(blocks: Block[], id: string): ToolBlock | undefined {
  for (const block of blocks) {
    if (block.type === "tool" && block.id === id) return block
  }
  return undefined
}

function findPermission(transcript: Transcript, id: string): PermissionItem | undefined {
  for (const item of transcript.items) {
    if (item.kind === "permission" && item.id === id) return item
  }
  return undefined
}

/** Pending requests from `permission.list()`, as render items. */
export function permissionItemsFromRequests(requests: readonly PermissionRequest[]): PermissionItem[] {
  return requests.map((request) => ({
    kind: "permission",
    id: request.id,
    action: request.action,
    resources: [...request.resources],
    save: [...(request.save ?? [])],
    ...(request.message === undefined ? {} : { message: request.message }),
    status: "pending",
  }))
}

/**
 * Add permissions that are not already on screen.
 *
 * Used after re-reading history, which drops transient items.
 */
export function mergePermissions(transcript: Transcript, items: readonly PermissionItem[]): boolean {
  let added = false
  for (const item of items) {
    if (!findPermission(transcript, item.id)) {
      transcript.items.push(item)
      added = true
    }
  }
  return added
}

/** Record an answer locally (the `permission.replied` event confirms it). */
export function resolvePermission(
  transcript: Transcript,
  requestID: string,
  decision: PermissionDecision,
): PermissionItem | undefined {
  const item = findPermission(transcript, requestID)
  if (!item) return undefined
  item.status = decision
  return item
}

/** Session id carried by an event, when it has one. */
export function sessionIDOfEvent(event: OpenCodeEvent): string | undefined {
  const data = (event as { data?: unknown }).data
  return isRecord(data) && typeof data.sessionID === "string" ? data.sessionID : undefined
}

/**
 * Apply one live event to the transcript.
 *
 * Returns whether anything changed, plus the id of the item that changed so the
 * host can post a cheap patch instead of the whole transcript.
 */
export function applyEvent(
  transcript: Transcript,
  event: OpenCodeEvent,
  sessionID: string,
): ApplyResult {
  switch (event.type) {
    case "session.execution.started": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      transcript.busy = true
      return { changed: true }
    }

    case "session.execution.succeeded":
    case "session.execution.interrupted":
    case "session.execution.failed": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      transcript.busy = false
      if (event.type === "session.execution.failed") {
        const last = lastAssistant(transcript)
        if (last) {
          last.error = event.data.error.message
          return { changed: true, itemID: last.id }
        }
      }
      return { changed: true }
    }

    case "session.step.started": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      // Creates the assistant bubble immediately so the panel can show a
      // "thinking" state before the first token arrives.
      const item = ensureAssistant(transcript, event.data.assistantMessageID)
      return { changed: true, itemID: item.id }
    }

    case "session.text.delta": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      const item = ensureAssistant(transcript, event.data.assistantMessageID)
      appendSegment(item.blocks, "text", event.data.ordinal, event.data.delta)
      delete item.error
      return { changed: true, itemID: item.id }
    }

    case "session.reasoning.delta": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      const item = ensureAssistant(transcript, event.data.assistantMessageID)
      appendSegment(item.blocks, "reasoning", event.data.ordinal, event.data.delta)
      return { changed: true, itemID: item.id }
    }

    case "session.tool.called": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      const item = ensureAssistant(transcript, event.data.assistantMessageID)
      if (!findTool(item.blocks, event.data.id)) {
        item.blocks.push({
          type: "tool",
          id: event.data.id,
          name: "",
          status: "running",
          label: toolLabel(event.data.input),
        })
      }
      return { changed: true, itemID: item.id }
    }

    case "session.tool.success": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      const item = ensureAssistant(transcript, event.data.assistantMessageID)
      const tool = findTool(item.blocks, event.data.id)
      if (tool) {
        tool.status = "done"
        const detail = contentText(event.data.content)
        if (detail !== undefined) tool.detail = detail
      }
      return { changed: true, itemID: item.id }
    }

    case "session.tool.failed": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      const item = ensureAssistant(transcript, event.data.assistantMessageID)
      const tool = findTool(item.blocks, event.data.id)
      if (tool) {
        tool.status = "error"
        tool.detail = contentText(event.data.content) ?? event.data.error.message
      }
      return { changed: true, itemID: item.id }
    }

    case "session.retry.scheduled": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      const item = ensureAssistant(transcript, event.data.assistantMessageID)
      item.error = `Retry ${event.data.attempt} scheduled: ${event.data.error.message}`
      return { changed: true, itemID: item.id }
    }

    case "session.idle": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      transcript.busy = false
      for (const item of transcript.items) {
        if (item.kind === "assistant") item.streaming = false
      }
      return { changed: true }
    }

    case "session.compaction.started": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      transcript.items.push({
        kind: "notice",
        id: `compaction-${event.id}`,
        level: "info",
        text: "Compacting this session to free up context.",
      })
      return { changed: true }
    }

    case "session.compaction.failed": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      transcript.items.push({
        kind: "notice",
        id: `compaction-${event.id}`,
        level: "error",
        text: `Compaction failed: ${event.data.error.message}`,
      })
      return { changed: true }
    }

    case "permission.asked": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      if (findPermission(transcript, event.data.id)) return { changed: false }
      transcript.items.push({
        kind: "permission",
        id: event.data.id,
        action: event.data.action,
        resources: [...event.data.resources],
        save: [...(event.data.save ?? [])],
        ...(event.data.message === undefined ? {} : { message: event.data.message }),
        status: "pending",
      })
      return { changed: true, itemID: event.data.id }
    }

    case "permission.replied": {
      if (event.data.sessionID !== sessionID) return { changed: false }
      const item = findPermission(transcript, event.data.requestID)
      if (!item || item.status === event.data.reply) return { changed: false }
      item.status = event.data.reply
      return { changed: true, itemID: item.id }
    }

    default:
      return { changed: false }
  }
}

function lastAssistant(transcript: Transcript): AssistantItem | undefined {
  for (let index = transcript.items.length - 1; index >= 0; index -= 1) {
    const item = transcript.items[index]
    if (item && item.kind === "assistant") return item
  }
  return undefined
}
