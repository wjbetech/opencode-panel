import { marked } from "marked"
import DOMPurify from "dompurify"
import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import c from "highlight.js/lib/languages/c"
import cpp from "highlight.js/lib/languages/cpp"
import csharp from "highlight.js/lib/languages/csharp"
import css from "highlight.js/lib/languages/css"
import diff from "highlight.js/lib/languages/diff"
import go from "highlight.js/lib/languages/go"
import ini from "highlight.js/lib/languages/ini"
import java from "highlight.js/lib/languages/java"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import kotlin from "highlight.js/lib/languages/kotlin"
import less from "highlight.js/lib/languages/less"
import markdown from "highlight.js/lib/languages/markdown"
import php from "highlight.js/lib/languages/php"
import plaintext from "highlight.js/lib/languages/plaintext"
import powershell from "highlight.js/lib/languages/powershell"
import python from "highlight.js/lib/languages/python"
import ruby from "highlight.js/lib/languages/ruby"
import rust from "highlight.js/lib/languages/rust"
import scss from "highlight.js/lib/languages/scss"
import shell from "highlight.js/lib/languages/shell"
import sql from "highlight.js/lib/languages/sql"
import stylus from "highlight.js/lib/languages/stylus"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"
import { totalTokens } from "../protocol"
import type { AssistantItem, ChatSummary, Item, ModelChoice, NoticeItem, PermissionItem, SessionUsage, UserItem } from "../protocol"

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

const api = acquireVsCodeApi()

/** Done-marks are keyed by snippet content so they survive re-renders. */
type PanelState = { done: Record<string, true> }

function loadState(): PanelState {
  const stored = api.getState() as PanelState | undefined
  if (stored && typeof stored === "object" && stored.done && typeof stored.done === "object") return stored
  return { done: {} }
}

const state = loadState()

function codeKey(language: string, source: string): string {
  const input = `${language}\u0000${source}`
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0
  }
  return String(hash >>> 0)
}

hljs.registerLanguage("bash", bash)
hljs.registerLanguage("c", c)
hljs.registerLanguage("cpp", cpp)
hljs.registerLanguage("csharp", csharp)
hljs.registerLanguage("css", css)
hljs.registerLanguage("diff", diff)
hljs.registerLanguage("go", go)
hljs.registerLanguage("ini", ini)
hljs.registerLanguage("java", java)
hljs.registerLanguage("javascript", javascript)
hljs.registerLanguage("json", json)
hljs.registerLanguage("kotlin", kotlin)
hljs.registerLanguage("less", less)
hljs.registerLanguage("markdown", markdown)
hljs.registerLanguage("php", php)
hljs.registerLanguage("plaintext", plaintext)
hljs.registerLanguage("powershell", powershell)
hljs.registerLanguage("python", python)
hljs.registerLanguage("ruby", ruby)
hljs.registerLanguage("rust", rust)
hljs.registerLanguage("scss", scss)
hljs.registerLanguage("shell", shell)
hljs.registerLanguage("sql", sql)
hljs.registerLanguage("stylus", stylus)
hljs.registerLanguage("typescript", typescript)
hljs.registerLanguage("xml", xml)
hljs.registerLanguage("yaml", yaml)

const messages = document.getElementById("messages") as HTMLElement
const input = document.getElementById("input") as HTMLTextAreaElement
const statusElement = document.getElementById("status") as HTMLElement
const sendButton = document.getElementById("send") as HTMLButtonElement
const playButton = document.getElementById("btn-play") as HTMLButtonElement
const stopButton = document.getElementById("btn-stop") as HTMLButtonElement
const chatsStrip = document.getElementById("sessions") as HTMLElement
const menuButton = document.getElementById("menu-button") as HTMLButtonElement
const menuList = document.getElementById("menu-list") as HTMLElement
const modelButton = document.getElementById("model-button") as HTMLButtonElement
const modelLabel = document.getElementById("model-label") as HTMLElement
const modelList = document.getElementById("model-list") as HTMLElement

const items = new Map<string, Item>()
const nodes = new Map<string, HTMLElement>()
const signatures = new Map<string, string>()

let pinned = true
let busy = false
let serverUrl = ""
/** The active chat's running token totals, shown when it is idle. */
let usage: SessionUsage | undefined

/** Models the server offers, by `providerID/id`. */
const modelIndex = new Map<string, ModelChoice>()
/** `providerID/id` the active chat runs with; "" until the server says. */
let currentModel = ""
/** Chats in this folder, newest first, as the host last listed them. */
let chats: ChatSummary[] = []

const showReasoning = document.body.dataset.showReasoning === "true"
const stripColorEmoji = document.body.dataset.stripColorEmoji !== "false"

// --------------------------------------------------------------------- helpers

function element(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A row of blocks that light up left to right; the panel's "working" pip. */
function blocksLoader(): HTMLElement {
  const holder = element("span", "blocks")
  holder.setAttribute("aria-hidden", "true")
  for (let index = 0; index < 5; index += 1) {
    const block = document.createElement("i")
    block.style.animationDelay = `${index * 0.13}s`
    holder.append(block)
  }
  return holder
}

/** What the model is doing right now, for the stream pip and the status bar. */
function activityOf(item: AssistantItem | undefined): string {
  if (!item) return "Thinking…"
  let running: string | undefined
  for (const block of item.blocks) {
    if (block.type === "tool" && block.status === "running") {
      const name = block.name.length > 0 ? block.name : "tool"
      running = block.label.length > 0 ? `Running ${name}: ${block.label}` : `Running ${name}…`
    }
  }
  if (running !== undefined) return running
  const last = item.blocks[item.blocks.length - 1]
  if (last?.type === "reasoning") return "Thinking…"
  if (last?.type === "text") return "Writing…"
  return "Thinking…"
}

function lastAssistant(): AssistantItem | undefined {
  let found: AssistantItem | undefined
  for (const item of items.values()) if (item.kind === "assistant") found = item
  return found
}

function streamIndicator(item: AssistantItem): HTMLElement {
  const wrap = element("div", "stream")
  wrap.append(blocksLoader(), element("span", "stream-text", activityOf(item)))
  return wrap
}

function renderMarkdown(target: HTMLElement, markdown: string): void {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string
  target.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
  decorateCode(target)
  decorateLinks(target)
  stripColorEmojis(target)
}

function actionButton(
  label: string,
  className: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = className
  button.textContent = label
  button.title = title
  button.addEventListener("click", onClick)
  return button
}

function codeButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  return actionButton(label, "chip", title, onClick)
}

/** Languages where a colour literal is worth previewing as a swatch. */
const COLOR_LANGUAGES = new Set(["css", "scss", "less", "stylus"])

/** Hex, `rgb()`/`rgba()` and `hsl()`/`hsla()` literals, as one whole token. */
const COLOR_PATTERN =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g

/** One text node plus the range of character offsets it covers in `root`. */
type OffsetSpan = { node: Text; start: number; end: number }

function offsetSpans(root: HTMLElement): OffsetSpan[] {
  const spans: OffsetSpan[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let position = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const length = text.nodeValue?.length ?? 0
    spans.push({ node: text, start: position, end: position + length })
    position += length
  }
  return spans
}

/** Map a character offset in the flattened text back onto a text node. */
function locateOffset(spans: OffsetSpan[], offset: number): { node: Text; offset: number } | undefined {
  for (const span of spans) {
    if (offset <= span.end) return { node: span.node, offset: Math.max(0, offset - span.start) }
  }
  const last = spans[spans.length - 1]
  if (!last) return undefined
  return { node: last.node, offset: last.node.nodeValue?.length ?? 0 }
}

/**
 * Show the real colour behind CSS colour literals.
 *
 * highlight.js splits values like `rgba(0, 0, 0, .5)` across several spans, so
 * this works on character offsets and inserts the swatch with a Range instead
 * of assuming the literal lives in one text node.
 */
function decorateColors(code: HTMLElement): void {
  const spans = offsetSpans(code)
  const source = code.textContent ?? ""
  if (spans.length === 0 || source.length === 0) return

  const matches: Array<{ start: number; end: number; value: string }> = []
  COLOR_PATTERN.lastIndex = 0
  for (let match = COLOR_PATTERN.exec(source); match; match = COLOR_PATTERN.exec(source)) {
    const value = match[0] ?? ""
    if (value.length > 0) matches.push({ start: match.index, end: match.index + value.length, value })
  }

  // Insert from the end backwards so earlier offsets stay valid as ranges split.
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const entry = matches[index]
    if (!entry) continue
    const start = locateOffset(spans, entry.start)
    const end = locateOffset(spans, entry.end)
    if (!start || !end) continue
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    range.collapse(false)
    range.insertNode(colorChip(entry.value))
  }
}

/** A swatch for one literal, or the literal itself when the browser rejects it. */
function colorChip(value: string): Node {
  const chip = document.createElement("span")
  chip.className = "color-chip"
  chip.style.backgroundColor = value
  if (chip.style.backgroundColor.length === 0) return document.createTextNode(value)
  chip.title = value
  return chip
}

/** Chars that may start a multi-char operator; never split inside one (`==`, `->`, `--`). */
const OPERATOR_RUN = new Set(["=", "!", "<", ">", "+", "-", "*", "/", "|", "&", "."])

function breakAfter(prev: string, char: string, next: string): boolean {
  if (next.length === 0 || /\s/.test(next)) return false
  switch (char) {
    case ",":
    case ";":
    case "(":
    case "[":
    case "{":
      return true
    case ":":
      // `https://…` stays together; `font-size:12px` still breaks after the colon.
      return next !== "/"
    case "/":
      return prev !== "/" && prev !== "*" && next !== "/" && next !== "*"
    case ".":
      return /[A-Za-z_$]/.test(next) && !OPERATOR_RUN.has(prev)
    case "=":
    case "+":
    case "*":
    case "|":
    case "&":
      return !OPERATOR_RUN.has(prev) && !OPERATOR_RUN.has(next)
    default:
      return false
  }
}

function breakBefore(prev: string, char: string, next: string): boolean {
  if (prev.length === 0 || /\s/.test(prev)) return false
  switch (char) {
    case ")":
    case "]":
    case "}":
      return true
    default:
      return false
  }
}

/**
 * Give the CSS wrapper sensible places to break long code lines.
 *
 * Highlighted code has no spaces to break at (`rgba(0,0,0,.5)`, URLs,
 * minified lines), so `<wbr>`s go after commas, brackets and lone operators
 * and before closing brackets. Display-only: Copy/Type/Open keep the exact
 * source. Runs after `decorateColors`, so it only walks the surviving text.
 */
function insertWrapOpportunities(code: HTMLElement): void {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const node of nodes) {
    const text = node.textContent ?? ""
    if (text.length < 2) continue
    let dirty = false
    const fragment = document.createDocumentFragment()
    let start = 0
    const flush = (end: number): void => {
      if (end > start) fragment.append(document.createTextNode(text.slice(start, end)))
      start = end
    }
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] ?? ""
      const prev = text[index - 1] ?? ""
      const next = text[index + 1] ?? ""
      if (breakAfter(prev, char, next)) {
        flush(index + 1)
        fragment.append(document.createElement("wbr"))
        dirty = true
      } else if (breakBefore(prev, char, next)) {
        flush(index)
        fragment.append(document.createElement("wbr"))
        dirty = true
      }
    }
    if (!dirty) continue
    flush(text.length)
    node.replaceWith(fragment)
  }
}

function decorateCode(scope: HTMLElement): void {
  for (const pre of Array.from(scope.querySelectorAll("pre"))) {
    const code = pre.querySelector("code")
    if (!code) continue

    const language = (code.className.match(/language-([\w+#.-]+)/) ?? [])[1] ?? ""
    const source = code.textContent ?? ""

    if (language.length > 0 && hljs.getLanguage(language)) {
      code.innerHTML = hljs.highlight(source, { language, ignoreIllegals: true }).value
      code.classList.add("hljs")
    } else {
      code.classList.add("hljs")
    }

    if (COLOR_LANGUAGES.has(language.toLowerCase())) decorateColors(code)
    insertWrapOpportunities(code)

    const wrapper = element("div", "code-block")
    const head = element("div", "code-head")
    const label = element("span", "code-lang", language.length > 0 ? language : "text")

    const actions = element("div", "code-actions")
    actions.append(
      codeButton("Copy", "Copy to clipboard", () => api.postMessage({ type: "copy", code: source })),
      codeButton("Type it", "Open an empty file with this language so you can type it yourself", () =>
        api.postMessage({ type: "scratch", language }),
      ),
      codeButton("Open", "Open this snippet in an editor tab", () =>
        api.postMessage({ type: "openFilled", language, code: source }),
      ),
      codeButton("Insert", "Insert at the cursor in the active editor", () =>
        api.postMessage({ type: "insert", code: source }),
      ),
    )

    const done = document.createElement("button")
    done.type = "button"
    done.className = "chip done"
    done.title = "Mark this snippet as reviewed / typed"

    const key = codeKey(language, source)
    const paint = (on: boolean): void => {
      wrapper.classList.toggle("is-done", on)
      done.textContent = on ? "Done ✓" : "Done"
    }
    paint(Boolean(state.done[key]))

    done.addEventListener("click", () => {
      const on = !wrapper.classList.contains("is-done")
      paint(on)
      if (on) state.done[key] = true
      else delete state.done[key]
      api.setState(state)
    })
    actions.append(done)

    head.append(label, actions)
    pre.replaceWith(wrapper)
    wrapper.append(head, pre)
  }
}

function decorateLinks(scope: HTMLElement): void {
  for (const anchor of Array.from(scope.querySelectorAll("a[href]"))) {
    anchor.addEventListener("click", (event) => {
      const href = anchor.getAttribute("href") ?? ""
      if (!/^https?:/i.test(href)) return
      event.preventDefault()
      api.postMessage({ type: "openLink", href })
    })
  }
}

/**
 * Color-square emojis (🟥 🟦 ⬛ …) models emit as makeshift swatches, plus the
 * plain geometric squares people use the same way.
 */
const COLOR_EMOJI_PATTERN =
  /[🟥🟧🟨🟩🟦🟪🟫⬛⬜◼◻◾◽▪▫■□]/gu

/**
 * Drop color-square emojis from prose.
 *
 * Models emit 🟦 next to a color name as a swatch; the panel's CSS snippets
 * already show the real color, so the emoji is redundant noise. Display-only:
 * the transcript underneath is untouched. Code is left alone — an emoji inside
 * a snippet is content, not decoration.
 */
function stripColorEmojis(scope: HTMLElement): void {
  if (!stripColorEmoji) return
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  for (const text of nodes) {
    if (text.parentElement?.closest("pre, code")) continue
    const value = text.nodeValue ?? ""
    COLOR_EMOJI_PATTERN.lastIndex = 0
    if (!COLOR_EMOJI_PATTERN.test(value)) continue
    COLOR_EMOJI_PATTERN.lastIndex = 0
    text.nodeValue = value.replace(COLOR_EMOJI_PATTERN, "").replace(/ {2,}/g, " ")
  }
}

// ---------------------------------------------------------------------- render

function renderUser(item: UserItem): HTMLElement {
  const article = element("article", "item user")
  article.dataset.id = item.id
  article.append(element("div", "bubble", item.text))
  return article
}

function renderNotice(item: NoticeItem): HTMLElement {
  const article = element("article", `item notice ${item.level}`)
  article.dataset.id = item.id
  article.append(element("div", "bubble", item.text))
  return article
}

function renderPermission(item: PermissionItem): HTMLElement {
  const article = element("article", `item permission ${item.status}`)
  article.dataset.id = item.id
  article.dataset.requestId = item.id

  const head = element("div", "perm-head")
  head.append(
    element("span", "perm-icon", "⚠"),
    element("span", "perm-title", `Permission required: ${item.action}`),
  )
  article.append(head)

  if (item.resources.length > 0) {
    const list = element("ul", "perm-resources")
    for (const resource of item.resources) list.append(element("li", undefined, resource))
    article.append(list)
  }

  if (item.message) article.append(element("div", "perm-message", item.message))

  if (item.status === "pending" && item.save.length > 0) {
    article.append(element("div", "perm-save", `Remembering "always" saves: ${item.save.join(", ")}`))
  }

  if (item.status !== "pending") {
    const label =
      item.status === "reject"
        ? "Rejected"
        : item.status === "always"
          ? "Allowed — remembered"
          : "Allowed once"
    article.append(element("div", "perm-outcome", label))
    return article
  }

  const reason = document.createElement("input")
  reason.type = "text"
  reason.className = "perm-reason"
  reason.placeholder = "Reason (optional, sent with Reject)"

  const actions = element("div", "perm-actions")
  const respond = (decision: string): void => {
    for (const button of Array.from(actions.querySelectorAll("button"))) {
      ;(button as HTMLButtonElement).disabled = true
    }
    api.postMessage({
      type: "permissionReply",
      requestID: item.id,
      decision,
      message: reason.value,
    })
  }

  actions.append(
    actionButton("Allow once", "do allow", "Run this tool call now", () => respond("once")),
    actionButton("Allow always", "do", "Run this and save a rule so it stops asking", () =>
      respond("always"),
    ),
    actionButton("Reject", "do reject", "Refuse this tool call", () => respond("reject")),
  )

  article.append(reason, actions)
  return article
}

function renderAssistant(item: AssistantItem): HTMLElement {
  const article = element("article", "item assistant")
  article.dataset.id = item.id
  if (item.streaming) article.classList.add("streaming")

  item.blocks.forEach((block, index) => {
    if (block.type === "text") {
      const holder = element("div", "md")
      holder.dataset.blockIndex = String(index)
      renderMarkdown(holder, block.text)
      article.append(holder)
      return
    }

    if (block.type === "reasoning") {
      const details = element("details", "reasoning") as HTMLDetailsElement
      details.dataset.blockIndex = String(index)
      details.open = false
      const summary = element("summary", undefined, "Thinking")
      const holder = element("div", "md")
      renderMarkdown(holder, block.text)
      details.append(summary, holder)
      if (!showReasoning) details.hidden = true
      article.append(details)
      return
    }

    const tool = element("div", `tool ${block.status}`)
    tool.dataset.blockIndex = String(index)
    const head = element("div", "tool-head")
    head.append(
      element("span", "tool-dot"),
      element("span", "tool-name", block.name.length > 0 ? block.name : "tool"),
    )
    if (block.label.length > 0) head.append(element("span", "tool-label", block.label))
    tool.append(head)
    if (block.detail) {
      const details = element("details", "tool-detail") as HTMLDetailsElement
      details.append(element("summary", undefined, block.status === "error" ? "Error" : "Result"))
      const pre = element("pre", "tool-output", block.detail)
      details.append(pre)
      tool.append(details)
    }
    article.append(tool)
  })

  if (item.error) {
    article.append(element("div", "item-error", item.error))
  }

  if (item.streaming) {
    article.append(streamIndicator(item))
  }

  return article
}

function renderItem(item: Item): HTMLElement {
  if (item.kind === "user") return renderUser(item)
  if (item.kind === "notice") return renderNotice(item)
  if (item.kind === "permission") return renderPermission(item)
  return renderAssistant(item)
}

function signatureOf(item: Item): string {
  if (item.kind === "user") return `user:${item.id}`
  if (item.kind === "notice") return `notice:${item.level}`
  if (item.kind === "permission") return `permission:${item.status}`
  if (item.kind === "assistant") {
    const parts = item.blocks.map((block) =>
      block.type === "tool"
        ? `tool:${block.id}:${block.status}:${block.detail?.length ?? 0}`
        : `${block.type}:${block.segment}`,
    )
    return `assistant:${parts.join("|")}:${item.error ?? ""}`
  }
  return "unknown"
}

function upsert(item: Item): void {
  items.set(item.id, item)
  updateStatus()
  const existing = nodes.get(item.id)
  const signature = signatureOf(item)

  if (!existing) {
    const node = renderItem(item)
    nodes.set(item.id, node)
    signatures.set(item.id, signature)
    messages.append(node)
    scrollIfPinned()
    return
  }

  if (signatures.get(item.id) !== signature) {
    const fresh = renderItem(item)
    nodes.set(item.id, fresh)
    signatures.set(item.id, signature)
    existing.replaceWith(fresh)
    scrollIfPinned()
    return
  }

  // Same shape: only the tail of the streaming message can have grown.
  if (item.kind === "assistant") {
    const index = item.blocks.length - 1
    const block = item.blocks[index]
    if (block && (block.type === "text" || block.type === "reasoning")) {
      const holder = existing.querySelector<HTMLElement>(`[data-block-index="${index}"]`)
      if (holder) renderMarkdown(holder, block.text)
    }
  }
  scrollIfPinned()
}

// ------------------------------------------------------------------- toolbar

/**
 * One dropdown at a time.
 *
 * The Menu and the model picker both open over the transcript, so opening
 * either closes the other; Escape or a click elsewhere closes both.
 */
type Overlay = { list: HTMLElement; button: HTMLButtonElement }
let openOverlay: Overlay | undefined

function closeOverlay(): void {
  if (!openOverlay) return
  openOverlay.list.hidden = true
  openOverlay.button.setAttribute("aria-expanded", "false")
  openOverlay = undefined
}

function toggleOverlay(overlay: Overlay): void {
  const wasOpen = !overlay.list.hidden
  closeOverlay()
  if (wasOpen) return

  overlay.list.hidden = false
  overlay.button.setAttribute("aria-expanded", "true")
  openOverlay = overlay
  const target =
    overlay.list.querySelector<HTMLElement>(".current") ??
    overlay.list.querySelector<HTMLElement>("button")
  target?.focus()
  target?.scrollIntoView({ block: "nearest" })
}

const menuOverlay: Overlay = { list: menuList, button: menuButton }
const modelOverlay: Overlay = { list: modelList, button: modelButton }

menuButton.addEventListener("click", () => toggleOverlay(menuOverlay))
modelButton.addEventListener("click", () => toggleOverlay(modelOverlay))

for (const item of Array.from(menuList.querySelectorAll<HTMLButtonElement>("button[data-action]"))) {
  item.addEventListener("click", () => {
    const action = item.dataset.action ?? ""
    closeOverlay()
    if (action.length > 0) api.postMessage({ type: action })
  })
}

document.addEventListener("click", (event) => {
  const target = event.target as Node | null
  if (openOverlay && target) {
    if (!openOverlay.list.contains(target) && !openOverlay.button.contains(target)) closeOverlay()
  }
  // A click elsewhere closes the touch-opened chats pane; hover still drives it.
  if (target && !chatsStrip.contains(target)) {
    chatsStrip.classList.remove("open")
    chatsStrip.querySelector(".current-chat")?.setAttribute("aria-expanded", "false")
  }
})

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return
  if (openOverlay) {
    const button = openOverlay.button
    closeOverlay()
    button.focus()
    return
  }
  chatsStrip.classList.remove("open")
  chatsStrip.querySelector(".current-chat")?.setAttribute("aria-expanded", "false")
})

/** The model button's label; CSS truncates it, the tooltip keeps the key. */
function updateModelLabel(): void {
  const choice = modelIndex.get(currentModel)
  modelLabel.textContent = choice ? choice.label : currentModel.length > 0 ? currentModel : "Model…"
  modelButton.title = choice
    ? `Model for this chat: ${choice.key}\nClick to choose another`
    : "Model for this chat"
  modelButton.disabled = modelIndex.size === 0
}

function modelOption(key: string, label: string, active: boolean, title?: string): HTMLButtonElement {
  const option = document.createElement("button")
  option.type = "button"
  option.className = "model-option"
  // The label lives in an inner span: `overflow` + `text-overflow` directly on
  // a <button> makes Chromium drop the text entirely, so the button only lays
  // out and the span truncates.
  option.append(element("span", "model-option-label", label.length > 0 ? label : key))
  option.title = title ?? key
  option.setAttribute("role", "option")
  option.setAttribute("aria-selected", String(active))
  if (active) option.classList.add("current")

  option.addEventListener("click", () => {
    const choice = modelIndex.get(key)
    closeOverlay()
    if (!choice) return
    currentModel = key
    updateModelLabel()
    renderChats()
    api.postMessage({ type: "selectModel", model: { id: choice.id, providerID: choice.providerID } })
  })
  return option
}

/**
 * Fill the model picker's dropdown.
 *
 * Options are grouped by provider: the server offers dozens of models whose
 * names share long prefixes, so the provider header is what makes the list
 * scannable once it is truncated to the pane's width.
 */
function renderModels(models: ModelChoice[], current: string): void {
  modelIndex.clear()
  currentModel = current
  for (const model of models) modelIndex.set(model.key, model)

  const byProvider = new Map<string, ModelChoice[]>()
  for (const model of models) {
    const group = byProvider.get(model.providerID)
    if (group) group.push(model)
    else byProvider.set(model.providerID, [model])
  }

  const children: HTMLElement[] = []

  // The chat can be on a model the catalog no longer offers; showing the raw
  // key keeps the picker from claiming a different model than the running one.
  if (current.length > 0 && !modelIndex.has(current)) children.push(modelOption(current, current, true))

  for (const [provider, entries] of [...byProvider.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    children.push(element("div", "model-group", provider))
    for (const model of [...entries].sort((left, right) => left.label.localeCompare(right.label))) {
      children.push(modelOption(model.key, model.label, model.key === current, model.key))
    }
  }

  modelList.replaceChildren(...children)
  updateModelLabel()
  // Rows name each chat's model, so they follow the catalog too.
  renderChats()
}

/**
 * Status pip for a chat: ⚠ when a tool call waits on you, the sweeping blocks
 * while it works, a green check once it is done.
 */
function statusMark(chat: ChatSummary): HTMLElement {
  const mark = element("span", "chat-mark")
  if (chat.waiting > 0) {
    mark.textContent = "⚠"
    mark.classList.add("warn")
  } else if (chat.busy) {
    mark.append(blocksLoader())
  } else {
    mark.textContent = "✓"
    mark.classList.add("done")
  }
  return mark
}

/** One-line status under the current chat's title: its model and what it is doing. */
function chatSubtitle(chat: ChatSummary): string {
  const parts: string[] = []
  const model = modelIndex.get(chat.model)
  if (model) parts.push(model.label)
  else if (chat.model.length > 0) parts.push(chat.model)
  if (chat.waiting > 0) parts.push(`${chat.waiting} waiting for your approval`)
  else if (chat.busy) parts.push("Working…")
  else parts.push("Done")
  return parts.join(" · ")
}

/** Tooltip for a chat: title, its own model and what it is doing. */
function chatTooltip(chat: ChatSummary): string {
  const title = chat.title.length > 0 ? chat.title : chat.id
  const model = modelIndex.get(chat.model)
  const tooltip = [title]
  if (model || chat.model.length > 0) {
    tooltip.push(`Model: ${model ? `${model.label} (${chat.model})` : chat.model}`)
  }
  if (chat.waiting > 0) tooltip.push(`${chat.waiting} tool call(s) waiting for your approval`)
  else if (chat.busy) tooltip.push("Working…")
  else tooltip.push("Done")
  return tooltip.join("\n")
}

/** One row in the hover pane: any chat but the one on screen. Same three-line
 *  shape as the current pane so every row is the same height and mousing
 *  through the list previews each task's model and status. */
function chatRow(chat: ChatSummary): HTMLElement {
  const row = document.createElement("button")
  row.type = "button"
  row.className = "chat-row"
  row.dataset.id = chat.id
  row.title = chatTooltip(chat)
  row.setAttribute("role", "menuitem")
  const text = element("div", "current-text")
  text.append(
    element("span", "current-title", chat.title.length > 0 ? chat.title : chat.id),
    element("span", "current-sub", chatSubtitle(chat)),
  )
  row.append(statusMark(chat), text)

  row.addEventListener("click", () => {
    chatsStrip.classList.remove("open")
    api.postMessage({ type: "switchChat", id: chat.id })
  })
  return row
}

/**
 * Draw the chats pane: a single pane for the task on screen, with the other
 * chats stacked underneath. CSS reveals the list on hover or focus; the `open`
 * class covers click/touch, where there is no hover.
 */
function renderChats(): void {
  chatsStrip.classList.remove("open")
  const active = chats.find((chat) => chat.active) ?? chats[0]

  if (!active) {
    const empty = document.createElement("div")
    empty.className = "current-chat"
    empty.append(element("span", "current-title", "No chats yet"))
    chatsStrip.replaceChildren(empty)
    return
  }

  const current = document.createElement("button")
  current.type = "button"
  current.className = "current-chat"
  current.title = `${chatTooltip(active)}\nHover to see the other chats`
  current.setAttribute("aria-haspopup", "true")
  current.setAttribute("aria-expanded", "false")
  const text = element("div", "current-text")
  text.append(
    element("span", "current-title", active.title.length > 0 ? active.title : active.id),
    element("span", "current-sub", chatSubtitle(active)),
  )
  current.append(statusMark(active), text)
  current.addEventListener("click", () => {
    const open = chatsStrip.classList.toggle("open")
    current.setAttribute("aria-expanded", String(open))
  })

  const list = element("div", "sessions-list")
  list.setAttribute("role", "menu")
  const others = chats.filter((chat) => chat.id !== active.id)
  for (const chat of others) list.append(chatRow(chat))

  const newChat = document.createElement("button")
  newChat.type = "button"
  newChat.className = "chat-row new"
  newChat.title = "Start another chat in this folder"
  newChat.setAttribute("role", "menuitem")
  newChat.append(element("span", "chat-mark", "+"), element("span", "chat-title", "New chat"))
  newChat.addEventListener("click", () => {
    chatsStrip.classList.remove("open")
    api.postMessage({ type: "newSession" })
  })
  list.append(newChat)

  chatsStrip.replaceChildren(current, list)
}

function replaceAll(next: Item[]): void {
  items.clear()
  nodes.clear()
  signatures.clear()
  messages.replaceChildren()
  for (const item of next) {
    items.set(item.id, item)
    const node = renderItem(item)
    nodes.set(item.id, node)
    signatures.set(item.id, signatureOf(item))
    messages.append(node)
  }
  updateStatus()
  scrollIfPinned()
}

function scrollIfPinned(): void {
  if (pinned) messages.scrollTop = messages.scrollHeight
}

function setBusy(value: boolean): void {
  busy = value
  sendButton.disabled = false
  updateStatus()
}

function pendingPermissionCount(): number {
  let count = 0
  for (const item of items.values()) {
    if (item.kind === "permission" && item.status === "pending") count += 1
  }
  return count
}

/** Compact token counts: 940, 12.3k, 1.2M. */
function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

function currentModelLabel(): string {
  if (currentModel.length === 0) return ""
  return modelIndex.get(currentModel)?.label ?? currentModel
}

/** The right-hand half of the idle strip: tokens used in this chat. */
function usageSummary(): string {
  if (!usage) return ""
  const total = totalTokens(usage.tokens)
  return total > 0 ? `${formatTokens(total)} tok` : ""
}

/** Hover text, so the model key, the token breakdown and the URL stay reachable. */
function statusTooltip(): string {
  const lines: string[] = []
  const choice = modelIndex.get(currentModel)
  if (choice) lines.push(`Model: ${choice.label} (${choice.key})`)
  else if (currentModel.length > 0) lines.push(`Model: ${currentModel}`)
  if (usage) {
    const tokens = usage.tokens
    if (totalTokens(tokens) > 0) {
      lines.push(`Tokens: ${tokens.input.toLocaleString()} in · ${tokens.output.toLocaleString()} out`)
      if (tokens.cacheRead > 0 || tokens.cacheWrite > 0) {
        lines.push(
          `Cache: ${tokens.cacheRead.toLocaleString()} read · ${tokens.cacheWrite.toLocaleString()} write`,
        )
      }
      if (tokens.reasoning > 0) lines.push(`Reasoning: ${tokens.reasoning.toLocaleString()}`)
    }
    if (usage.cost > 0) lines.push(`Cost: $${usage.cost.toFixed(4)}`)
  }
  if (serverUrl.length > 0) lines.push(serverUrl)
  return lines.join("\n")
}

function updateStatus(): void {
  stopButton.hidden = !busy
  playButton.hidden = busy
  const pending = pendingPermissionCount()
  statusElement.classList.toggle("busy", busy && pending === 0)
  statusElement.classList.toggle("warn", pending > 0)
  statusElement.title = statusTooltip()

  if (pending > 0) {
    statusElement.textContent = `Waiting for your approval (${pending})`
    return
  }

  if (busy) {
    statusElement.textContent = activityOf(lastAssistant())
    return
  }

  // Idle: the chat's model on the left, its token total on the right.
  const children: HTMLElement[] = []
  const label = currentModelLabel()
  if (label.length > 0) children.push(element("span", "status-model", label))
  const summary = usageSummary()
  if (summary.length > 0) children.push(element("span", "status-usage", summary))
  if (children.length === 0 && serverUrl.length > 0) {
    children.push(element("span", "status-model", serverUrl))
  }
  statusElement.replaceChildren(...children)
}

// ------------------------------------------------------------------- messaging

messages.addEventListener("scroll", () => {
  pinned = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80
})

sendButton.addEventListener("click", () => submit())

playButton.addEventListener("click", () => submit())

stopButton.addEventListener("click", () => api.postMessage({ type: "interrupt" }))

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
})

function submit(): void {
  const text = input.value.trim()
  if (text.length === 0) return
  input.value = ""
  api.postMessage({ type: "prompt", text })
}

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as Record<string, unknown>
  if (!data || typeof data.type !== "string") return

  if (data.type === "replace") {
    replaceAll((data.items as Item[]) ?? [])
    const server = data.server as { url?: string } | undefined
    if (server?.url) serverUrl = server.url
    usage = (data.usage as SessionUsage | undefined) ?? undefined
    setBusy(Boolean(data.busy))
    return
  }

  if (data.type === "patch") {
    for (const item of (data.items as Item[]) ?? []) upsert(item)
    return
  }

  if (data.type === "chats") {
    chats = (data.chats as ChatSummary[]) ?? []
    renderChats()
    return
  }

  if (data.type === "settings") {
    usage = (data.usage as SessionUsage | undefined) ?? undefined
    renderModels((data.models as ModelChoice[]) ?? [], typeof data.current === "string" ? data.current : "")
    updateStatus()
    return
  }

  if (data.type === "usage") {
    usage = (data.usage as SessionUsage | undefined) ?? undefined
    updateStatus()
    return
  }

  if (data.type === "busy") {
    setBusy(Boolean(data.busy))
    return
  }
})

// Paint the chats pane up front so "New chat" is there before the first
// listing, and the idle status so the bar never starts blank.
renderChats()
updateStatus()

api.postMessage({ type: "ready" })
