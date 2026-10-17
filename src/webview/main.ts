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
import type { AssistantItem, Item, ModelChoice, NoticeItem, PermissionItem, UserItem } from "../protocol"

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
const modelPicker = document.getElementById("model-picker") as HTMLSelectElement | null

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
    article.append(element("div", "cursor"))
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

const modelIndex = new Map<string, ModelChoice>()

/**
 * Fill the model picker. Options are grouped by provider: the server offers
 * dozens of models whose names share prefixes.
 */
function renderModels(models: ModelChoice[], current: string): void {
  if (!modelPicker) return
  modelIndex.clear()

  const byProvider = new Map<string, ModelChoice[]>()
  for (const model of models) {
    modelIndex.set(model.key, model)
    const group = byProvider.get(model.providerID)
    if (group) group.push(model)
    else byProvider.set(model.providerID, [model])
  }

  const children: HTMLElement[] = []
  if (current.length === 0 || !modelIndex.has(current)) {
    const option = document.createElement("option")
    option.value = ""
    option.textContent = current.length === 0 ? "Model…" : current
    if (current.length === 0) option.disabled = true
    children.push(option)
  }

  for (const [provider, entries] of [...byProvider.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const group = document.createElement("optgroup")
    group.label = provider
    for (const model of [...entries].sort((left, right) => left.label.localeCompare(right.label))) {
      const option = document.createElement("option")
      option.value = model.key
      option.textContent = model.label
      option.title = model.key
      group.append(option)
    }
    children.push(group)
  }

  modelPicker.replaceChildren(...children)
  modelPicker.value = current.length === 0 ? "" : current
  modelPicker.disabled = models.length === 0
  modelPicker.title = modelPicker.selectedOptions[0]?.title ?? "Model for this session"
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

function updateStatus(): void {
  stopButton.hidden = !busy
  const pending = pendingPermissionCount()
  statusElement.classList.toggle("busy", busy && pending === 0)
  statusElement.classList.toggle("warn", pending > 0)
  if (pending > 0) statusElement.textContent = `Waiting for your approval (${pending})`
  else if (busy) statusElement.textContent = "Working…"
  else statusElement.textContent = serverUrl
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
document.getElementById("btn-import")?.addEventListener("click", () => api.postMessage({ type: "importChat" }))
document.getElementById("btn-backport")?.addEventListener("click", () => api.postMessage({ type: "backportChat" }))

modelPicker?.addEventListener("change", () => {
  const choice = modelIndex.get(modelPicker.value)
  if (!choice) return
  api.postMessage({ type: "selectModel", model: { id: choice.id, providerID: choice.providerID } })
})

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

  if (data.type === "settings") {
    renderModels((data.models as ModelChoice[]) ?? [], typeof data.current === "string" ? data.current : "")
    return
  }

  if (data.type === "busy") {
    setBusy(Boolean(data.busy))
    return
  }
})

api.postMessage({ type: "ready" })
