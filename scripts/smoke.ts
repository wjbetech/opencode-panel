/**
 * Headless smoke test for the panel's data path.
 *
 * Exercises exactly what the extension host does - discover the server, create a
 * session, stream live events through `applyEvent`, then re-read history through
 * `fromMessages` - so a green run means the webview would have had something
 * sensible to render.
 *
 * Usage: node dist/smoke.mjs [--keep]
 */
import { resolveClient } from "../src/server"
import {
  applyEvent,
  emptyTranscript,
  fromMessages,
  sessionIDOfEvent,
  type Transcript,
} from "../src/protocol"

const directory = process.cwd()
const keep = process.argv.includes("--keep")
const WATCHDOG_MS = 180_000

const PROMPT =
  "Write a TypeScript function `sum(a: number, b: number): number` in ONE ```ts fenced code block. No prose before or after."

function assistantText(transcript: Transcript): string {
  return transcript.items
    .flatMap((item) => (item.kind === "assistant" ? item.blocks : []))
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
}

function normalise(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error("\nsmoke: timed out waiting for the model")
    process.exit(1)
  }, WATCHDOG_MS)

  const resolved = await resolveClient({ directory, log: (message) => console.log(`  · ${message}`) })
  console.log(`server      : ${resolved.url} (auth: ${resolved.authenticated ? "yes" : "no"})`)

  const session = await resolved.client.session.create({
    title: "opencode-panel smoke test",
    location: { directory },
  })
  console.log(`session     : ${session.id}`)

  const transcript = emptyTranscript()
  let deltas = 0
  let tools = 0
  const controller = new AbortController()

  const consumer = (async () => {
    for await (const event of resolved.client.event.subscribe({ signal: controller.signal })) {
      if (sessionIDOfEvent(event) !== session.id) continue
      if (event.type === "session.text.delta") deltas += 1
      if (event.type === "session.tool.called") tools += 1
      applyEvent(transcript, event, session.id)
      // A turn ends with an execution outcome. `session.idle` exists in the
      // schema but is not emitted by this server version.
      if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted"
      ) {
        break
      }
    }
  })()

  console.log(`prompt      : ${PROMPT}`)
  await resolved.client.session.prompt({ sessionID: session.id, text: PROMPT })
  await consumer
  controller.abort()

  const streamed = assistantText(transcript)
  console.log("\n--- streamed ---")
  console.log(streamed.trim().slice(0, 600))

  const stored = await resolved.client.message.list({ sessionID: session.id })
  const reloaded = fromMessages(stored.data)
  const history = assistantText(reloaded)

  console.log("\n--- history ---")
  console.log(history.trim().slice(0, 600))

  const fenced = /```[\w+#.-]*\n[\s\S]*?```/.test(history)
  const items = reloaded.items.length
  const agrees = normalise(history).includes(normalise(streamed).slice(0, 80))

  console.log("\n--- checks ---")
  console.log(`text deltas          : ${deltas}`)
  console.log(`tool calls           : ${tools}`)
  console.log(`history items        : ${items}`)
  console.log(`fenced code in history: ${fenced}`)
  console.log(`history matches stream: ${agrees}`)

  const pass = deltas > 0 && fenced && items > 0
  console.log(pass ? "SMOKE: PASS" : "SMOKE: FAIL")

  if (!keep) {
    await resolved.client.session.remove({ sessionID: session.id })
    console.log("smoke session removed")
  }

  clearTimeout(watchdog)
  process.exitCode = pass ? 0 : 1
}

main().catch((error: unknown) => {
  console.error("smoke: failed")
  console.error(error)
  process.exitCode = 1
})
