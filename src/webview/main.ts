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
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"
import type { AssistantItem, Item, NoticeItem, UserItem } from "../protocol"

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
hljs.registerLanguage("typescript", typescript)
hljs.registerLanguage("xml", xml)
hljs.registerLanguage("yaml", yaml)

const messages = document.getElementById("messages") as HTMLElement
const input = document.getElementById("input") as HTMLTextAreaElement
const statusElement = document.getElementById("status") as HTMLElement
const sessionLabel = document.getElementById("session-label") as HTMLElement
const sendButton = document.getElementById("send") as HTMLButtonElement
const stopButton = document.getElementById("btn-stop") as HTMLButtonElement

const items = new Map<string, Item>()
const nodes = new Map<string, HTMLElement>()
const signatures = new Map<string, string>()

let pinned = true
let busy = false
let serverUrl = ""

const showReasoning = document.body.dataset.showReasoning === "true"

// --------------------------------------------------------------------- helpers

function element(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function renderMarkdown(target: HTMLElement, markdown: string): void {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string
  target.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
  decorateCode(target)
  decorateLinks(target)
}

function codeButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "chip"
  button.textContent = label
  button.title = title
  button.addEventListener("click", onClick)
  return button
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
    article.append(element("div", "cursor"))
  }

  return article
}

function renderItem(item: Item): HTMLElement {
  if (item.kind === "user") return renderUser(item)
  if (item.kind === "notice") return renderNotice(item)
  return renderAssistant(item)
}

function signatureOf(item: Item): string {
  if (item.kind === "user") return `user:${item.id}`
  if (item.kind === "notice") return `notice:${item.level}`
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
  scrollIfPinned()
}

function scrollIfPinned(): void {
  if (pinned) messages.scrollTop = messages.scrollHeight
}

function setBusy(value: boolean): void {
  busy = value
  stopButton.hidden = !value
  sendButton.disabled = false
  if (value) {
    statusElement.textContent = "Working…"
    statusElement.classList.add("busy")
  } else {
    statusElement.classList.remove("busy")
    statusElement.textContent = serverUrl
  }
}

// ------------------------------------------------------------------- messaging

messages.addEventListener("scroll", () => {
  pinned = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80
})

sendButton.addEventListener("click", () => submit())

stopButton.addEventListener("click", () => api.postMessage({ type: "interrupt" }))

document.getElementById("btn-new")?.addEventListener("click", () => api.postMessage({ type: "newSession" }))
document.getElementById("btn-refresh")?.addEventListener("click", () => api.postMessage({ type: "refresh" }))
document.getElementById("btn-sessions")?.addEventListener("click", () => api.postMessage({ type: "pickSession" }))

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
    const session = data.session as { id?: string; title?: string } | undefined
    if (session) sessionLabel.textContent = session.title || session.id || ""
    const server = data.server as { url?: string } | undefined
    if (server?.url) serverUrl = server.url
    setBusy(Boolean(data.busy))
    return
  }

  if (data.type === "patch") {
    for (const item of (data.items as Item[]) ?? []) upsert(item)
    return
  }

  if (data.type === "busy") {
    setBusy(Boolean(data.busy))
    return
  }
})

api.postMessage({ type: "ready" })
