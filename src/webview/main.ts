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
import type { AgentChoice, AssistantItem, AttachmentRef, ChatSummary, CommandChoice, Item, ModelChoice, NoticeItem, PermissionItem, RevertInfo, SessionUsage, SkillChoice, UserItem } from "../protocol"

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

const api = acquireVsCodeApi()

/** Done-marks are keyed by snippet content; history recalls submitted prompts. */
type PanelState = { done: Record<string, true>; history?: string[] }

function loadState(): PanelState {
  const stored = api.getState() as PanelState | undefined
  if (stored && typeof stored === "object" && stored.done && typeof stored.done === "object") {
    if (!Array.isArray(stored.history)) stored.history = []
    return stored
  }
  return { done: {}, history: [] }
}

const state = loadState()

/** Submitted prompts, oldest first; Up/Down in an empty composer walks them. */
const HISTORY_CAP = 50
let historyIndex = -1
let historyDraft = ""

function pushHistory(text: string): void {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  const history = (state.history ??= [])
  if (history[history.length - 1] !== trimmed) history.push(trimmed)
  while (history.length > HISTORY_CAP) history.shift()
  historyIndex = -1
  historyDraft = ""
  api.setState(state)
}

function recallHistory(delta: -1 | 1): boolean {
  const history = state.history ?? []
  if (history.length === 0) return false
  if (historyIndex === -1) {
    if (delta > 0 || input.value.trim().length > 0) return false
    historyDraft = input.value
    historyIndex = history.length - 1
  } else {
    const next = historyIndex + delta
    if (next < 0) return true
    if (next >= history.length) {
      historyIndex = -1
      input.value = historyDraft
      historyDraft = ""
      return true
    }
    historyIndex = next
  }
  input.value = history[historyIndex] ?? ""
  return true
}

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
const app = document.getElementById("app") as HTMLElement
const input = document.getElementById("input") as HTMLTextAreaElement
const statusElement = document.getElementById("status") as HTMLElement
const sendButton = document.getElementById("send") as HTMLButtonElement
const playButton = document.getElementById("btn-play") as HTMLButtonElement
const stopButton = document.getElementById("btn-stop") as HTMLButtonElement
const chatsStrip = document.getElementById("sessions") as HTMLElement
const menuButton = document.getElementById("menu-button") as HTMLButtonElement
const menuList = document.getElementById("menu-list") as HTMLElement
const fontButton = document.getElementById("menu-font-button") as HTMLButtonElement
const fontValue = document.getElementById("menu-font-value") as HTMLElement
const fontList = document.getElementById("menu-font-list") as HTMLElement

/** Unscaled type sizes, read before any scaling applies. Code falls back to body. */
const baseFontSize = parseFloat(getComputedStyle(document.body).fontSize) || 13
const baseCodeSize =
  parseFloat(getComputedStyle(document.body).getPropertyValue("--vscode-editor-font-size")) || baseFontSize
const modelButton = document.getElementById("model-button") as HTMLButtonElement
const modelLabel = document.getElementById("model-label") as HTMLElement
const modelList = document.getElementById("model-list") as HTMLElement
const agentButton = document.getElementById("agent-button") as HTMLButtonElement
const agentLabel = document.getElementById("agent-label") as HTMLElement
const agentList = document.getElementById("agent-list") as HTMLElement
const skillButton = document.getElementById("skill-button") as HTMLButtonElement
const skillLabel = document.getElementById("skill-label") as HTMLElement
const skillList = document.getElementById("skill-list") as HTMLElement
const variantButton = document.getElementById("variant-button") as HTMLButtonElement
const variantLabel = document.getElementById("variant-label") as HTMLElement
const variantList = document.getElementById("variant-list") as HTMLElement
const modeBadge = document.getElementById("mode-badge") as HTMLElement
const atButton = document.getElementById("at-button") as HTMLButtonElement
const imgButton = document.getElementById("btn-image") as HTMLButtonElement
const attachBar = document.getElementById("attach-bar") as HTMLElement
const revertBar = document.getElementById("revert-bar") as HTMLElement
const cmdList = document.getElementById("cmd-list") as HTMLElement

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
/** Agents the server offers, by id. */
const agentIndex = new Map<string, AgentChoice>()
/** Agent id the active chat runs with; "" until the server says. */
let currentAgent = ""
/** Mode of that agent (`primary`/`subagent`/`all`); "" until known. */
let agentMode = ""
/** Skills the server offers, by id. */
const skillIndex = new Map<string, SkillChoice>()
/** Last skill activated in this chat; "" when none. */
let currentSkill = ""
/** Variant ids the current model offers. */
let variants: string[] = []
/** Variant the chat runs with; "" means the model default. */
let currentVariant = ""
/** Chats in this folder, newest first, as the host last listed them. */
let chats: ChatSummary[] = []
/** Session id the transcript on screen belongs to; checkpoints clear on switch. */
let lastSessionID = ""
/** Slash commands the server offers (`/fix`, …). */
let commands: CommandChoice[] = []
/** Files `@`-mentioned into the next prompt. */
let attachments: AttachmentRef[] = []
/** A staged undo checkpoint waiting for commit or dismiss. */
let pendingRevert: RevertInfo | undefined

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

/**
 * Keep a single inline working pip on screen.
 *
 * A multi-step turn creates one assistant item per step, each with its own
 * `.stream` loader while it runs. Showing them all stacks N identical
 * "Thinking…" animations (screenshot). The status bar already mirrors
 * `activityOf(lastAssistant())`, so hiding every pip but the last loses
 * nothing and leaves exactly one animation.
 */
function refreshStreams(): void {
  const actives = Array.from(messages.querySelectorAll<HTMLElement>(":scope > .item.assistant.streaming .stream"))
  for (let index = 0; index < actives.length; index += 1) {
    const node = actives[index]
    if (!node) continue
    node.style.display = index === actives.length - 1 ? "" : "none"
  }
}

function renderMarkdown(target: HTMLElement, markdown: string): void {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string
  target.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
  decorateCode(target)
  decorateLinks(target)
  linkifyFiles(target)
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
      if (/^https?:/i.test(href)) {
        event.preventDefault()
        api.postMessage({ type: "openLink", href })
        return
      }
      // A markdown-authored relative link (`[panel](src/panel.ts)`) opens in
      // the editor when it points at a file; otherwise leave it alone.
      const ref = parseFileRef(href.replace(/#.*$/, ""))
      if (ref) {
        event.preventDefault()
        api.postMessage({ type: "openFile", path: ref.path, line: ref.line, col: ref.col })
      }
    })
  }
}

/** Extensions worth linkifying; keeps `word.Word` prose and `a@b.com` quiet. */
const FILE_EXTS = new Set(
  "ts tsx mts cts js jsx mjs cjs json jsonc md mdx css scss sass less html htm xml svg vue svelte astro py pyi rb rs go java kt kts cs cpp cxx cc c h hpp hxx swift php scala pl pm r sql sh bash zsh fish ps1 psm1 bat cmd yml yaml toml ini cfg conf env properties gradle txt log diff patch".split(
    " ",
  ),
)

/** Extensionless files worth linkifying (`Dockerfile:12`). */
const BARE_FILES = new Set(
  "dockerfile makefile readme license changelog contributing gemfile rakefile brewfile justfile earthfile taskfile".split(" "),
)

/** `path`, `path:12` or `path:12:4` (drive letters and `./` survive). */
const FILE_CANDIDATE =
  /(?:[A-Za-z]:)?[\\/]?(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z0-9]{1,6}(?::\d+(?::\d+)?)?|\b(?:Dockerfile|Makefile|README|LICENSE|CHANGELOG|CONTRIBUTING|Gemfile|Rakefile|Brewfile|Justfile|Earthfile|Taskfile)(?::\d+(?::\d+)?)?/g

type FileRef = { path: string; line?: number; col?: number }

/** Split a `path[:line[:col]]` token; undefined when it is not a known file. */
function parseFileRef(token: string): FileRef | undefined {
  const match = token.match(/^(.*?)(?::(\d+)(?::(\d+))?)?$/)
  if (!match) return undefined
  const rawPath = (match[1] ?? "").replace(/[.,;!?)\]}"'’”]+$/, "")
  if (rawPath.length === 0) return undefined
  const lower = rawPath.toLowerCase()
  const dot = lower.lastIndexOf(".")
  const slash = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\"))
  if (dot > slash) {
    if (!FILE_EXTS.has(lower.slice(dot + 1))) return undefined
  } else {
    const base = lower.slice(slash + 1)
    if (!BARE_FILES.has(base)) return undefined
  }
  const ref: FileRef = { path: rawPath }
  if (match[2] !== undefined) ref.line = Math.max(1, parseInt(match[2], 10))
  if (match[3] !== undefined) ref.col = Math.max(1, parseInt(match[3], 10))
  return ref
}

/**
 * Turn `src/panel.ts:123` mentions into editor links (prose, including inline
 * `code`, permission resources, user bubbles). Fenced blocks and tool output
 * are content, not mentions, so every `pre` is skipped.
 */
function linkifyFiles(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  for (const text of nodes) {
    const parent = text.parentElement
    if (!parent || parent.closest("a, pre")) continue
    const value = text.nodeValue ?? ""
    FILE_CANDIDATE.lastIndex = 0
    let match: RegExpExecArray | null
    let at = 0
    let dirty = false
    const fragment = document.createDocumentFragment()
    while ((match = FILE_CANDIDATE.exec(value)) !== null) {
      const token = match[0] ?? ""
      const ref = parseFileRef(token)
      if (!ref) continue
      const start = match.index
      if (start > at) fragment.append(document.createTextNode(value.slice(at, start)))
      at = start + token.length
      const anchor = document.createElement("a")
      anchor.href = "#"
      anchor.className = "file-link"
      anchor.textContent = token
      anchor.title =
        ref.line !== undefined ? `Open ${ref.path} at line ${ref.line}` : `Open ${ref.path}`
      anchor.addEventListener("click", (event) => {
        event.preventDefault()
        api.postMessage({ type: "openFile", path: ref.path, line: ref.line, col: ref.col })
      })
      fragment.append(anchor)
      dirty = true
    }
    if (!dirty) continue
    if (at < value.length) fragment.append(document.createTextNode(value.slice(at)))
    text.replaceWith(fragment)
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
  const bubble = element("div", "bubble", item.text)
  linkifyFiles(bubble)
  article.append(bubble)
  if (item.images && item.images.length > 0) {
    const row = element("div", "user-images")
    for (const name of item.images) {
      row.append(element("span", "user-image", `🖼 ${name}`))
    }
    article.append(row)
  }
  // Server-known messages can be rewound to: stage an undo checkpoint here.
  if (!item.id.startsWith("local-")) {
    const undo = document.createElement("button")
    undo.type = "button"
    undo.className = "undo-btn"
    undo.textContent = "Undo to here"
    undo.title = "Rewind this chat to before this message (restores files)"
    undo.addEventListener("click", () => api.postMessage({ type: "revertStage", messageID: item.id }))
    article.append(undo)
  }
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
    for (const resource of item.resources) {
      const entry = element("li", undefined, resource)
      linkifyFiles(entry)
      list.append(entry)
    }
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
  } else {
    // Copy the response as markdown (prose blocks; tool calls stay in history).
    const markdown = item.blocks
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .filter((text) => text.length > 0)
      .join("\n\n")
    if (markdown.length > 0) {
      const copy = document.createElement("button")
      copy.type = "button"
      copy.className = "resp-copy"
      copy.textContent = "Copy response"
      copy.title = "Copy this response as markdown"
      copy.addEventListener("click", () => api.postMessage({ type: "copy", text: markdown }))
      article.append(copy)
    }
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
    refreshStreams()
    scrollIfPinned()
    return
  }

  if (signatures.get(item.id) !== signature) {
    const fresh = renderItem(item)
    nodes.set(item.id, fresh)
    signatures.set(item.id, signature)
    existing.replaceWith(fresh)
    refreshStreams()
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
const agentOverlay: Overlay = { list: agentList, button: agentButton }
const skillOverlay: Overlay = { list: skillList, button: skillButton }
const variantOverlay: Overlay = { list: variantList, button: variantButton }

menuButton.addEventListener("click", () => toggleOverlay(menuOverlay))
modelButton.addEventListener("click", () => toggleOverlay(modelOverlay))
agentButton.addEventListener("click", () => toggleOverlay(agentOverlay))
skillButton.addEventListener("click", () => toggleOverlay(skillOverlay))
variantButton.addEventListener("click", () => toggleOverlay(variantOverlay))

for (const item of Array.from(menuList.querySelectorAll<HTMLButtonElement>("button[data-action]"))) {
  item.addEventListener("click", () => {
    const action = item.dataset.action ?? ""
    closeFontList()
    closeOverlay()
    if (action.length > 0) api.postMessage({ type: action })
  })
}

/**
 * The Text-size submenu inside the Menu: an inline secondary dropdown.
 * It toggles in place (no side-flyout to clip in the narrow pane) and stays
 * inside `menuList`, so the parent overlay's outside-click handling ignores it.
 */
function closeFontList(): void {
  fontList.hidden = true
  fontButton.setAttribute("aria-expanded", "false")
}

fontButton.addEventListener("click", () => {
  const open = fontList.hidden
  closeFontList()
  if (open) {
    fontList.hidden = false
    fontButton.setAttribute("aria-expanded", "true")
  }
})

for (const option of Array.from(fontList.querySelectorAll<HTMLButtonElement>("button[data-font]"))) {
  option.addEventListener("click", () => {
    const scale = Number(option.dataset.font ?? "")
    if (Number.isFinite(scale)) api.postMessage({ type: "setFontScale", scale })
  })
}

/** Apply a text size: grow type only (never layout boxes), and paint the submenu state. */
function applyFontScale(scale: number): void {
  const valid = [0.85, 1, 1.15, 1.3].includes(scale) ? scale : 1
  document.body.style.fontSize = `${baseFontSize * valid}px`
  app.style.setProperty("--vscode-editor-font-size", `${baseCodeSize * valid}px`)
  fontValue.textContent = `${Math.round(valid * 100)}%`
  for (const option of Array.from(fontList.querySelectorAll<HTMLButtonElement>("button[data-font]"))) {
    const active = Number(option.dataset.font ?? "") === valid
    option.classList.toggle("current", active)
    option.setAttribute("aria-checked", String(active))
  }
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
  if (!fontList.hidden) {
    closeFontList()
    fontButton.focus()
    return
  }
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
  updateCtxBar()
  // Rows name each chat's model, so they follow the catalog too.
  renderChats()
}

/**
 * The slim context bar under the composer buttons, TUI footer style.
 *
 * TUI row 1 shows `agent · model · variant`; the panel keeps the model picker
 * at the top and mirrors agent/skill/variant down here. Opencode has no native
 * `harness` type, so the agent `mode` badge is the closest native signal.
 */
function updateCtxBar(): void {
  const agent = agentIndex.get(currentAgent)
  agentLabel.textContent = agent ? agent.name : currentAgent.length > 0 ? currentAgent : "…"
  agentButton.title = agent
    ? `Agent for this chat: ${agent.name} (${agent.id}, ${agent.mode || "unknown mode"})\n${agent.description}\nClick to choose another (TUI: /agents)`
    : "Agent for this chat (TUI: /agents)"
  agentButton.disabled = agentIndex.size === 0

  const skill = skillIndex.get(currentSkill)
  skillLabel.textContent = skill ? skill.name : currentSkill.length > 0 ? currentSkill : "none"
  skillButton.title = skill
    ? `Last skill activated here: ${skill.name}\n${skill.description}\nClick to activate another (TUI: /skills)`
    : "No skill activated in this chat yet\nClick to activate one (TUI: /skills)"
  skillButton.disabled = skillIndex.size === 0

  variantLabel.textContent = currentVariant.length > 0 ? currentVariant : "default"
  variantButton.title =
    variants.length > 0
      ? `Model variant / reasoning effort: ${currentVariant.length > 0 ? currentVariant : "default"}\nOffers: ${variants.join(", ")}\nClick to choose (TUI: /variants, Ctrl+T cycles)`
      : "Model variant (this model offers none)"
  variantButton.disabled = variants.length === 0

  if (agentMode.length > 0) {
    modeBadge.hidden = false
    modeBadge.textContent = agentMode
    modeBadge.title = "Agent mode (opencode has no separate harness type; this is the closest native signal)"
  } else {
    modeBadge.hidden = true
    modeBadge.textContent = ""
  }
}

function ctxOption(label: string, active: boolean, title: string, onPick: () => void): HTMLButtonElement {
  const option = document.createElement("button")
  option.type = "button"
  option.className = "model-option"
  option.append(element("span", "model-option-label", label.length > 0 ? label : title))
  option.title = title
  option.setAttribute("role", "option")
  option.setAttribute("aria-selected", String(active))
  if (active) option.classList.add("current")
  option.addEventListener("click", () => {
    closeOverlay()
    onPick()
  })
  return option
}

/** Fill the agent picker's dropdown, grouped by mode like the TUI picker. */
function renderAgents(agents: AgentChoice[], current: string): void {
  agentIndex.clear()
  currentAgent = current
  for (const agent of agents) agentIndex.set(agent.id, agent)

  const byMode = new Map<string, AgentChoice[]>()
  for (const agent of agents) {
    const group = byMode.get(agent.mode.length > 0 ? agent.mode : "other")
    if (group) group.push(agent)
    else byMode.set(agent.mode.length > 0 ? agent.mode : "other", [agent])
  }

  const children: HTMLElement[] = []
  if (current.length > 0 && !agentIndex.has(current)) {
    children.push(
      ctxOption(current, true, current, () => api.postMessage({ type: "selectAgent", agent: current })),
    )
  }
  for (const [mode, entries] of [...byMode.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    children.push(element("div", "model-group", mode))
    for (const agent of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const title = agent.description.length > 0 ? `${agent.name} (${agent.id})\n${agent.description}` : agent.id
      children.push(
        ctxOption(agent.name, agent.id === current, title, () =>
          api.postMessage({ type: "selectAgent", agent: agent.id }),
        ),
      )
    }
  }

  agentList.replaceChildren(...children)
  updateCtxBar()
}

/** Fill the skill picker's dropdown. Skills activate immediately via `session.skill`. */
function renderSkills(skills: SkillChoice[], current: string): void {
  skillIndex.clear()
  currentSkill = current
  for (const skill of skills) skillIndex.set(skill.id, skill)

  const children: HTMLElement[] = []
  if (current.length > 0 && !skillIndex.has(current)) {
    children.push(ctxOption(current, true, current, () => api.postMessage({ type: "selectSkill", skill: current })))
  }
  for (const skill of [...skills].sort((left, right) => left.name.localeCompare(right.name))) {
    const title = skill.description.length > 0 ? `${skill.name}\n${skill.description}` : skill.id
    children.push(
      ctxOption(skill.name, skill.id === current, title, () =>
        api.postMessage({ type: "selectSkill", skill: skill.id }),
      ),
    )
  }

  skillList.replaceChildren(...children)
  updateCtxBar()
}

/** Fill the variant picker's dropdown, plus a Default entry that clears it. */
function renderVariants(options: string[], current: string): void {
  variants = [...options]
  currentVariant = current

  const children: HTMLElement[] = [
    ctxOption("default", current.length === 0, "Model default (clear the variant override)", () =>
      api.postMessage({ type: "selectVariant", variant: "" }),
    ),
  ]
  for (const variant of variants) {
    children.push(
      ctxOption(variant, variant === current, `Variant: ${variant}`, () =>
        api.postMessage({ type: "selectVariant", variant }),
      ),
    )
  }

  variantList.replaceChildren(...children)
  updateCtxBar()
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

/** Tooltip for a chat: title, its own model, origin, age and what it is doing. */
function chatTooltip(chat: ChatSummary): string {
  const title = chat.title.length > 0 ? chat.title : chat.id
  const model = modelIndex.get(chat.model)
  const tooltip = [title, `Session: ${chat.id}`]
  if (model || chat.model.length > 0) {
    tooltip.push(`Model: ${model ? `${model.label} (${chat.model})` : chat.model}`)
  }
  tooltip.push(`Origin: ${chat.origin === "pane" ? "this pane" : "TUI / elsewhere"}`)
  if (chat.agent.length > 0) tooltip.push(`Agent: ${chat.agent}`)
  if (chat.parentID.length > 0) tooltip.push(`Parent task: ${chat.parentID}`)
  if (chat.updated > 0) tooltip.push(`Updated: ${new Date(chat.updated).toLocaleString()}`)
  if (chat.waiting > 0) tooltip.push(`${chat.waiting} tool call(s) waiting for your approval`)
  else if (chat.busy) tooltip.push("Working…")
  else tooltip.push("Done")
  return tooltip.join("\n")
}

/** Short form of a session id (`ses_…a1b2c3`); ids are unique per chat. */
function shortID(id: string): string {
  const tail = id.startsWith("ses_") ? id.slice(4) : id
  return tail.length > 6 ? `ses_…${tail.slice(-6)}` : id
}

/** Relative age (`5m`, `2h`, `3d`) matching the TUI session list; "" when unknown. */
function relTime(updated: number): string {
  if (updated <= 0) return ""
  const seconds = Math.max(0, Math.floor((Date.now() - updated) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(updated).toLocaleDateString()
}

/**
 * Identity line under the status: the chat's own session id, where it was
 * born (`pane` highlighted, `tui` dimmed), its age, agent and parent task.
 * Structured spans so the origin badge keeps its own color; every chat has
 * an id and an origin, so every row keeps the same three-line height.
 */
function chatMeta(chat: ChatSummary): HTMLElement {
  const meta = element("span", "current-meta")
  meta.append(document.createTextNode(shortID(chat.id)))
  meta.append(document.createTextNode(" · "))
  const origin = element("span", `origin-${chat.origin}`, chat.origin)
  origin.title = chat.origin === "pane" ? "Started in this pane" : "Started in the TUI or elsewhere"
  meta.append(origin)
  const age = relTime(chat.updated)
  if (age.length > 0) {
    meta.append(document.createTextNode(` · ${age}`))
    if (chat.updated > 0) meta.title = `Updated ${new Date(chat.updated).toLocaleString()}`
  }
  if (chat.agent.length > 0) meta.append(document.createTextNode(` · ${chat.agent}`))
  if (chat.parentID.length > 0) meta.append(document.createTextNode(` · ↳ ${shortID(chat.parentID)}`))
  return meta
}

/** One row in the hover pane: any chat but the one on screen. Same three-line
 *  shape as the current pane so every row is the same height and mousing
 *  through the list previews each task's model, status and identity. A div
 *  wrapper holds the switch button and the copy button (buttons cannot nest). */
function chatRow(chat: ChatSummary): HTMLElement {
  const row = element("div", "chat-row")
  row.dataset.id = chat.id
  row.title = chatTooltip(chat)

  const main = document.createElement("button")
  main.type = "button"
  main.className = "chat-main"
  main.title = "Switch to this chat"
  const text = element("div", "current-text")
  text.append(
    element("span", "current-title", chat.title.length > 0 ? chat.title : chat.id),
    element("span", "current-sub", chatSubtitle(chat)),
    chatMeta(chat),
  )
  main.append(statusMark(chat), text)
  main.addEventListener("click", () => {
    chatsStrip.classList.remove("open")
    api.postMessage({ type: "switchChat", id: chat.id })
  })

  const copy = document.createElement("button")
  copy.type = "button"
  copy.className = "chat-copy"
  copy.textContent = "⧉"
  copy.title = "Copy chat reference (title + session id)"
  copy.setAttribute("aria-label", `Copy reference for ${chat.title.length > 0 ? chat.title : chat.id}`)
  copy.addEventListener("click", (event) => {
    event.stopPropagation()
    api.postMessage({ type: "copyChat", id: chat.id })
  })

  row.append(main, copy, delButton(chat.id, chat.title.length > 0 ? chat.title : chat.id))
  return row
}

/** Copy button for the current-chat header (same reference format as rows). */
function copyButton(id: string, label: string): HTMLButtonElement {
  const copy = document.createElement("button")
  copy.type = "button"
  copy.className = "chat-copy"
  copy.textContent = "⧉"
  copy.title = "Copy chat reference (title + session id)"
  copy.setAttribute("aria-label", `Copy reference for ${label}`)
  copy.addEventListener("click", (event) => {
    event.stopPropagation()
    api.postMessage({ type: "copyChat", id })
  })
  return copy
}

/** Delete button: same spot as copy, red on hover. The host confirms first. */
function delButton(id: string, label: string): HTMLButtonElement {
  const del = document.createElement("button")
  del.type = "button"
  del.className = "chat-del"
  del.title = `Delete "${label}"`
  del.setAttribute("aria-label", `Delete ${label}`)
  del.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 4.2h10.4M6.4 4V2.8h3.2V4M4.2 4.2l.7 9.3h6.2l.7-9.3M6.8 7v4.2M9.2 7v4.2"/></svg>'
  del.addEventListener("click", (event) => {
    event.stopPropagation()
    api.postMessage({ type: "deleteChat", id })
  })
  return del
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

  const current = element("div", "current-chat")
  current.title = `${chatTooltip(active)}\nHover to see the other chats`
  const switchBtn = document.createElement("button")
  switchBtn.type = "button"
  switchBtn.className = "chat-main"
  switchBtn.title = "Show the other chats"
  switchBtn.setAttribute("aria-haspopup", "true")
  switchBtn.setAttribute("aria-expanded", "false")
  const text = element("div", "current-text")
  text.append(
    element("span", "current-title", active.title.length > 0 ? active.title : active.id),
    element("span", "current-sub", chatSubtitle(active)),
    chatMeta(active),
  )
  switchBtn.append(statusMark(active), text)
  switchBtn.addEventListener("click", () => {
    const open = chatsStrip.classList.toggle("open")
    switchBtn.setAttribute("aria-expanded", String(open))
  })
  current.append(
    switchBtn,
    copyButton(active.id, active.title.length > 0 ? active.title : active.id),
    delButton(active.id, active.title.length > 0 ? active.title : active.id),
  )

  const list = element("div", "sessions-list")
  list.setAttribute("role", "menu")
  const others = chats.filter((chat) => chat.id !== active.id)
  for (const chat of others) list.append(chatRow(chat))

  const newChat = element("div", "chat-row new")
  newChat.title = "Start another chat in this folder"
  const newMain = document.createElement("button")
  newMain.type = "button"
  newMain.className = "chat-main"
  newMain.title = "Start another chat in this folder"
  const newText = element("div", "current-text")
  newText.append(
    element("span", "current-title", "New chat"),
    element("span", "current-sub", "Start another chat in this folder"),
  )
  newMain.append(element("span", "chat-mark", "+"), newText)
  newMain.addEventListener("click", () => {
    chatsStrip.classList.remove("open")
    api.postMessage({ type: "newSession" })
  })
  newChat.append(newMain)
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
  refreshStreams()
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
      const context = choice?.context ?? 0
      lines.push(
        context > 0
          ? `Context: ${totalTokens(tokens).toLocaleString()} / ${context.toLocaleString()} (${Math.round((totalTokens(tokens) / context) * 100)}%)`
          : `Tokens: ${tokens.input.toLocaleString()} in · ${tokens.output.toLocaleString()} out`,
      )
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

/** Thin context-window bar above the composer: fill = tokens used vs the model's window. */
function renderUsageBar(): void {
  const bar = document.getElementById("usage-bar") as HTMLElement | null
  if (!bar) return
  const fill = bar.firstElementChild as HTMLElement | null
  if (!fill) return
  const total = usage ? totalTokens(usage.tokens) : 0
  const context = modelIndex.get(currentModel)?.context ?? 0
  if (context <= 0 || total <= 0) {
    bar.hidden = true
    return
  }
  const ratio = Math.min(1, total / context)
  bar.hidden = false
  bar.classList.toggle("warn", ratio >= 0.7 && ratio < 0.9)
  bar.classList.toggle("full", ratio >= 0.9)
  fill.style.width = `${Math.max(2, Math.round(ratio * 100))}%`
  bar.title = `Context ${total.toLocaleString()} / ${context.toLocaleString()} (${Math.round(ratio * 100)}%) — ${currentModelLabel()}`
}

function updateStatus(): void {
  stopButton.hidden = !busy
  playButton.hidden = busy
  renderUsageBar()
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

atButton.addEventListener("click", () => api.postMessage({ type: "pickContext" }))
imgButton.addEventListener("click", () => api.postMessage({ type: "pickImage" }))

input.addEventListener("keydown", (event) => {
  // TUI parity: Ctrl+T cycles the model variant (`variant_cycle`).
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "t") {
    event.preventDefault()
    api.postMessage({ type: "cycleVariant" })
    return
  }
  if (!cmdList.hidden && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Escape")) {
    if (event.key === "Escape") {
      cmdList.hidden = true
      return
    }
    event.preventDefault()
    moveCmdSelection(event.key === "ArrowDown" ? 1 : -1)
    return
  }
  // Empty-composer history: Up recalls the last prompt, Up/Down walk the rest.
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    if (recallHistory(event.key === "ArrowUp" ? -1 : 1)) {
      event.preventDefault()
      return
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    if (!cmdList.hidden) {
      const pick = cmdList.querySelector<HTMLButtonElement>(".cmd-option.selected") ??
        cmdList.querySelector<HTMLButtonElement>(".cmd-option")
      if (pick) {
        event.preventDefault()
        pick.click()
        return
      }
    }
    event.preventDefault()
    submit()
  }
})

input.addEventListener("input", () => {
  historyIndex = -1
  historyDraft = ""
  renderCmdPicker()
})

/** `@token` mention spans for the attached files found in the prompt text. */
function attachmentPayload(text: string): {
  files: Array<{ uri: string; mention?: { start: number; end: number; text: string } }>
  images: Array<{ name: string; dataUrl: string; mention: { start: number; end: number; text: string } }>
} {
  const files: Array<{ uri: string; mention?: { start: number; end: number; text: string } }> = []
  const images: Array<{ name: string; dataUrl: string; mention: { start: number; end: number; text: string } }> = []
  for (const attachment of attachments) {
    const token = `@${attachment.token}`
    const start = text.indexOf(token)
    if (start < 0) continue
    const mention = { start, end: start + token.length, text: token }
    if (attachment.dataUrl) images.push({ name: attachment.token, dataUrl: attachment.dataUrl, mention })
    else files.push({ uri: attachment.uri, mention })
  }
  return { files, images }
}

function submit(): void {
  const text = input.value.trim()
  if (text.length === 0) return
  pushHistory(text)
  // Steering: `/name args` runs a server slash command instead of a prompt.
  if (text.startsWith("/")) {
    const space = text.indexOf(" ")
    const name = (space < 0 ? text.slice(1) : text.slice(1, space)).trim()
    const args = space < 0 ? "" : text.slice(space + 1)
    if (name.length > 0) {
      input.value = ""
      cmdList.hidden = true
      attachments = []
      renderAttachments()
      api.postMessage({ type: "command", name, text: args })
      return
    }
  }
  const { files, images } = attachmentPayload(input.value)
  input.value = ""
  cmdList.hidden = true
  attachments = []
  renderAttachments()
  api.postMessage({ type: "prompt", text, files, images })
}

/** Chips for the `@`-mentioned files; × drops one from the next prompt. */
function renderAttachments(): void {
  attachBar.replaceChildren()
  if (attachments.length === 0) {
    attachBar.hidden = true
    return
  }
  attachBar.hidden = false
  for (const attachment of attachments) {
    const chip = element("span", "attach-chip")
    chip.title = attachment.label.length > 0 ? attachment.label : attachment.uri
    if (attachment.dataUrl) {
      const thumb = document.createElement("img")
      thumb.className = "attach-thumb"
      thumb.src = attachment.dataUrl
      thumb.alt = ""
      chip.append(thumb)
    }
    chip.append(element("span", "attach-token", `@${attachment.token}`))
    const drop = document.createElement("button")
    drop.type = "button"
    drop.className = "attach-drop"
    drop.textContent = "×"
    drop.title = `Remove @${attachment.token} from the next prompt`
    drop.setAttribute("aria-label", `Remove @${attachment.token}`)
    drop.addEventListener("click", () => {
      attachments = attachments.filter((candidate) => candidate !== attachment)
      renderAttachments()
    })
    chip.append(drop)
    attachBar.append(chip)
  }
}

/** Accepted clipboard/drop image types, mapped to file extensions. */
const IMAGE_EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
}

/** Pasted/dropped images larger than this are refused with a notice. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024

let imageCounter = 0

/** Stage clipboard/dropped images as `@`-mentioned attachments. */
function attachImageFiles(files: Iterable<File>): void {
  for (const file of files) {
    const ext = IMAGE_EXTS[file.type] ?? (/\.(png|jpe?g|gif|webp|bmp)$/i.exec(file.name)?.[1]?.toLowerCase())
    if (!ext || file.size > MAX_IMAGE_BYTES) continue
    imageCounter += 1
    const token = `image-${Date.now().toString(36)}-${imageCounter}.${ext === "jpeg" ? "jpg" : ext}`
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : ""
      if (!dataUrl.startsWith("data:image/")) return
      attachments.push({ uri: "", token, label: file.name.length > 0 ? file.name : "Pasted image", dataUrl })
      insertToken(token)
      renderAttachments()
    }
    reader.readAsDataURL(file)
  }
}

/** Insert `@token ` at the caret so the mention survives into the prompt. */
function insertToken(token: string): void {
  const at = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? at
  const snippet = `@${token} `
  input.value = `${input.value.slice(0, at)}${snippet}${input.value.slice(end)}`
  input.focus()
}

input.addEventListener("paste", (event) => {
  const files = event.clipboardData ? Array.from(event.clipboardData.files) : []
  if (!files.some((file) => file.type.startsWith("image/"))) return
  event.preventDefault()
  attachImageFiles(files.filter((file) => file.type.startsWith("image/")))
})

input.addEventListener("dragover", (event) => event.preventDefault())
input.addEventListener("drop", (event) => {
  const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : []
  if (files.length === 0) return
  event.preventDefault()
  attachImageFiles(files)
})

/** Slash-command picker under the composer, filtered as `/…` is typed. */
function renderCmdPicker(): void {
  const text = input.value
  if (!text.startsWith("/") || text.includes("\n") || commands.length === 0) {
    cmdList.hidden = true
    return
  }
  const query = text.slice(1).split(" ")[0]?.toLowerCase() ?? ""
  const matches = commands.filter((command) => command.name.toLowerCase().startsWith(query)).slice(0, 8)
  if (matches.length === 0) {
    cmdList.hidden = true
    return
  }
  cmdList.replaceChildren()
  cmdList.hidden = false
  matches.forEach((command, index) => {
    const option = document.createElement("button")
    option.type = "button"
    option.className = `cmd-option${index === 0 ? " selected" : ""}`
    option.setAttribute("role", "option")
    option.title = command.description.length > 0 ? `/${command.name}\n${command.description}` : `/${command.name}`
    option.append(
      element("span", "cmd-name", `/${command.name}`),
      element("span", "cmd-desc", command.description),
    )
    option.addEventListener("click", () => {
      const rest = text.includes(" ") ? text.slice(text.indexOf(" ")) : ""
      input.value = `/${command.name}${rest.length > 0 ? rest : " "}`
      cmdList.hidden = true
      input.focus()
    })
    cmdList.append(option)
  })
}

function moveCmdSelection(delta: number): void {
  const options = Array.from(cmdList.querySelectorAll<HTMLButtonElement>(".cmd-option"))
  if (options.length === 0) return
  const at = options.findIndex((option) => option.classList.contains("selected"))
  const next = options[(at + delta + options.length) % options.length]
  for (const option of options) option.classList.remove("selected")
  next?.classList.add("selected")
  next?.scrollIntoView({ block: "nearest" })
}

/** Undo checkpoint banner: what rewinds, which files, commit or dismiss. */
function renderRevertBar(): void {
  revertBar.replaceChildren()
  if (!pendingRevert) {
    revertBar.hidden = true
    return
  }
  revertBar.hidden = false
  const info = element(
    "span",
    "revert-info",
    pendingRevert.files.length > 0
      ? `Undo to "${pendingRevert.preview}" — restores ${pendingRevert.files.length} file(s): ${pendingRevert.files.slice(0, 3).join(", ")}${pendingRevert.files.length > 3 ? "…" : ""}`
      : `Undo to "${pendingRevert.preview}" — no file changes to restore`,
  )
  const commit = document.createElement("button")
  commit.type = "button"
  commit.className = "do allow"
  commit.textContent = "Restore & rewind"
  commit.title = "Restore files and rewind the transcript"
  commit.addEventListener("click", () => api.postMessage({ type: "revertCommit" }))
  const dismiss = document.createElement("button")
  dismiss.type = "button"
  dismiss.className = "do"
  dismiss.textContent = "Keep"
  dismiss.title = "Drop the checkpoint without changing anything"
  dismiss.addEventListener("click", () => api.postMessage({ type: "revertClear" }))
  revertBar.append(info, commit, dismiss)
}

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as Record<string, unknown>
  if (!data || typeof data.type !== "string") return

  if (data.type === "replace") {
    replaceAll((data.items as Item[]) ?? [])
    const server = data.server as { url?: string } | undefined
    if (server?.url) serverUrl = server.url
    usage = (data.usage as SessionUsage | undefined) ?? undefined
    const session = data.session as { id?: string } | undefined
    if (session?.id && session.id !== lastSessionID) {
      // A different chat on screen: its checkpoints are its own business.
      lastSessionID = session.id
      pendingRevert = undefined
      renderRevertBar()
    }
    setBusy(Boolean(data.busy))
    if (typeof data.fontScale === "number") applyFontScale(data.fontScale)
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
    renderAgents((data.agents as AgentChoice[]) ?? [], typeof data.currentAgent === "string" ? data.currentAgent : "")
    if (typeof data.agentMode === "string") agentMode = data.agentMode
    renderSkills((data.skills as SkillChoice[]) ?? [], typeof data.currentSkill === "string" ? data.currentSkill : "")
    commands = (data.commands as CommandChoice[]) ?? []
    renderVariants(
      Array.isArray(data.variants) ? (data.variants as string[]) : [],
      typeof data.currentVariant === "string" ? data.currentVariant : "",
    )
    if (typeof data.fontScale === "number") applyFontScale(data.fontScale)
    updateStatus()
    return
  }

  if (data.type === "contextAdded") {
    const attachment = data.attachment as AttachmentRef | undefined
    if (attachment && (attachment.uri.length === 0 || !attachments.some((candidate) => candidate.uri === attachment.uri))) {
      // Same-basename files from different folders share a token: suffix it.
      let token = attachment.token
      for (let n = 2; attachments.some((candidate) => candidate.token === token); n += 1) {
        token = `${attachment.token}-${n}`
      }
      attachments.push({ ...attachment, token })
      insertToken(token)
      renderAttachments()
    }
    return
  }

  if (data.type === "insertText") {
    const text = typeof data.text === "string" ? data.text : ""
    if (text.length > 0) {
      const at = input.selectionStart ?? input.value.length
      const end = input.selectionEnd ?? at
      input.value = `${input.value.slice(0, at)}${text}${input.value.slice(end)}`
      input.focus()
    }
    return
  }

  if (data.type === "revertStaged") {
    pendingRevert = (data.revert as RevertInfo | undefined) ?? undefined
    renderRevertBar()
    return
  }

  if (data.type === "revertCleared" || data.type === "revertCommitted") {
    pendingRevert = undefined
    renderRevertBar()
    return
  }

  if (data.type === "context") {
    if (Array.isArray(data.agents)) renderAgents(data.agents as AgentChoice[], typeof data.currentAgent === "string" ? data.currentAgent : currentAgent)
    else if (typeof data.currentAgent === "string") {
      currentAgent = data.currentAgent
    }
    if (typeof data.agentMode === "string") agentMode = data.agentMode
    if (Array.isArray(data.skills)) renderSkills(data.skills as SkillChoice[], typeof data.currentSkill === "string" ? data.currentSkill : currentSkill)
    else if (typeof data.currentSkill === "string") currentSkill = data.currentSkill
    updateCtxBar()
    return
  }

  if (data.type === "usage") {
    usage = (data.usage as SessionUsage | undefined) ?? undefined
    updateStatus()
    return
  }

  if (data.type === "fontScale") {
    if (typeof data.fontScale === "number") applyFontScale(data.fontScale)
    return
  }

  if (data.type === "busy") {
    setBusy(Boolean(data.busy))
    return
  }
})

// Paint the chats pane up front so "New chat" is there before the first
// listing, and the idle status so the bar never starts blank.
applyFontScale(1)
renderChats()
updateStatus()

api.postMessage({ type: "ready" })
