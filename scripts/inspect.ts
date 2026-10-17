/**
 * Diagnostics: inspect one session and watch the raw event stream.
 *
 * Usage: node dist/inspect.mjs [sessionID] [--seconds 20]
 */
import { resolveClient } from "../src/server"

const directory = process.cwd()
const args = process.argv.slice(2)
const secondsIndex = args.indexOf("--seconds")
const seconds = secondsIndex >= 0 ? Number(args[secondsIndex + 1] ?? "20") : 20
const sessionID = args.find((value) => value.startsWith("ses_"))

const resolved = await resolveClient({ directory, log: (m) => console.log(`  · ${m}`) })
console.log(`server: ${resolved.url} (auth: ${resolved.authenticated ? "yes" : "no"})`)

const info = await resolved.client.server.info()
console.log(`info  : ${JSON.stringify(info)}`)

if (sessionID) {
  const session = await resolved.client.session.get({ sessionID })
  console.log(`session: ${session.id} "${session.title ?? ""}" outcome=${session.outcome ?? "none"}`)

  const messages = await resolved.client.message.list({ sessionID })
  console.log(`messages: ${messages.data.length}`)
  for (const message of messages.data) {
    const summary =
      message.type === "assistant"
        ? message.content
            .map((part) =>
              part.type === "text"
                ? `text(${part.text.length})`
                : part.type === "reasoning"
                  ? `reasoning(${part.text.length})`
                  : `tool(${part.name}/${part.state.status})`,
            )
            .join(", ")
        : message.type === "user"
          ? message.text.slice(0, 60)
          : ""
    console.log(`  - ${message.type}: ${summary}`)
  }
} else {
  const sessions = await resolved.client.session.list({ directory, limit: 5, order: "desc" })
  console.log(`recent sessions in ${directory}:`)
  for (const session of sessions.data) {
    console.log(`  - ${session.id} "${session.title ?? ""}" outcome=${session.outcome ?? "none"}`)
  }
}

console.log(`\nwatching events for ${seconds}s ...`)
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), seconds * 1000)
let count = 0
try {
  for await (const event of resolved.client.event.subscribe({ signal: controller.signal })) {
    count += 1
    const data = (event as { data?: unknown }).data as Record<string, unknown> | undefined
    const session = typeof data?.sessionID === "string" ? data.sessionID : ""
    const extra =
      typeof data?.delta === "string"
        ? `delta=${JSON.stringify(data.delta.slice(0, 40))}`
        : typeof data?.id === "string"
          ? `id=${data.id}`
          : ""
    console.log(`  ${event.type}${session ? ` ${session}` : ""} ${extra}`)
  }
} catch (error) {
  if (!controller.signal.aborted) console.error("stream error", error)
}
clearTimeout(timer)
console.log(`events seen: ${count}`)
process.exit(0)
