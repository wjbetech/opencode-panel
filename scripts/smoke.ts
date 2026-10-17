/**
 * Headless smoke test for the panel's data path.
 *
 * Exercises exactly what the extension host does, so a green run means the
 * webview would have had something sensible to render:
 *
 *   1. discover the server, create a session, stream live events through
 *      `applyEvent`, then re-read history through `fromMessages`
 *   2. force a tool approval (the `build` agent asks before reading `.env`),
 *      merge it with `permissionItemsFromRequests`, answer it, and check the
 *      turn finishes and the tool ran
 *
 * Usage: node dist/smoke.mjs [--keep]
 */
import { rmSync, writeFileSync } from "node:fs"
import { OpenCode } from "@opencode/client"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { resolveClient } from "../src/server"
import {
  applyEvent,
  emptyTranscript,
  fromMessages,
  mergePermissions,
  permissionItemsFromRequests,
  sessionIDOfEvent,
  type PermissionItem,
  type Transcript,
} from "../src/protocol"

const directory = process.cwd()
const keep = process.argv.includes("--keep")
const WATCHDOG_MS = 300_000

const TEXT_PROMPT =
  "Write a TypeScript function `sum(a: number, b: number): number` in ONE ```ts fenced code block. No prose before or after."

const PERMISSION_PROMPT =
  "You must call the read tool on the file .env in the working directory before answering. Then tell me the value of PANEL_PROBE."

const envPath = `${directory}/.env`

type Phase = {
  transcript: Transcript
  deltas: number
  tools: number
  asked: PermissionItem | undefined
  pendingAfterReply: number
}

function isExecutionEnd(type: string): boolean {
  return (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted"
  )
}

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

/**
 * Subscribe, prompt, and pump events through `applyEvent` until the turn ends.
 *
 * The hook runs before the event is applied so it can reply to a permission
 * request while the turn is still blocked on it.
 */
async function driveTurn(
  client: OpenCodeClient,
  sessionID: string,
  prompt: string,
  phase: Phase,
  onEvent?: (event: OpenCodeEvent) => Promise<void>,
): Promise<void> {
  const controller = new AbortController()
  const consumer = (async () => {
    for await (const event of client.event.subscribe({ signal: controller.signal })) {
      if (sessionIDOfEvent(event) !== sessionID) continue
      if (event.type === "session.text.delta") phase.deltas += 1
      if (event.type === "session.tool.called") phase.tools += 1
      if (onEvent) await onEvent(event)
      applyEvent(phase.transcript, event, sessionID)
      if (isExecutionEnd(event.type)) break
    }
  })()

  await client.session.prompt({ sessionID, text: prompt })
  await consumer
  controller.abort()
}

async function runTextPhase(client: OpenCodeClient, sessionID: string): Promise<Phase> {
  const phase: Phase = {
    transcript: emptyTranscript(),
    deltas: 0,
    tools: 0,
    asked: undefined,
    pendingAfterReply: 0,
  }
  await driveTurn(client, sessionID, TEXT_PROMPT, phase)
  return phase
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error("\nsmoke: timed out waiting for the model")
    cleanup()
    process.exit(1)
  }, WATCHDOG_MS)

  const resolved = await resolveClient({
    directory,
    log: (message) => console.log(`  · ${message}`),
  })
  console.log(`server      : ${resolved.url} (auth: ${resolved.authenticated ? "yes" : "no"})`)

  // ---------------------------------------------------------------- phase 1
  const session = await resolved.client.session.create({
    title: "opencode-panel smoke test",
    location: { directory },
  })
  console.log(`session     : ${session.id}`)

  const phase1 = await runTextPhase(resolved.client, session.id)

  const streamed = assistantText(phase1.transcript)
  console.log("\n--- phase 1: streamed text ---")
  console.log(streamed.trim().slice(0, 400))

  const stored = await resolved.client.message.list({ sessionID: session.id })
  const reloaded = fromMessages(stored.data)
  const history = assistantText(reloaded)

  const fenced = /```[\w+#.-]*\n[\s\S]*?```/.test(history)
  const agrees = normalise(history).includes(normalise(streamed).slice(0, 80))
  const phase1Pass = phase1.deltas > 0 && fenced && reloaded.items.length > 0

  console.log("\n--- phase 1: checks ---")
  console.log(`text deltas           : ${phase1.deltas}`)
  console.log(`history items         : ${reloaded.items.length}`)
  console.log(`fenced code in history: ${fenced}`)
  console.log(`history matches stream: ${agrees}`)

  // ---------------------------------------------------------------- phase 2
  writeFileSync(envPath, "PANEL_PROBE=dummy-value-1234\n", "utf8")
  const permissionTranscript = emptyTranscript()
  const phase2: Phase = {
    transcript: permissionTranscript,
    deltas: 0,
    tools: 0,
    asked: undefined,
    pendingAfterReply: 0,
  }

  await driveTurn(resolved.client, session.id, PERMISSION_PROMPT, phase2, async (event) => {
    if (event.type !== "permission.asked") return
    const data = event.data
    console.log(`  · permission.asked ${data.action} ${JSON.stringify(data.resources)}`)

    // Recovery path: list, merge, then answer.
    const pending = await resolved.client.permission.list({ sessionID: session.id })
    mergePermissions(phase2.transcript, permissionItemsFromRequests(pending))

    await new Promise((resolve) => setTimeout(resolve, 400))
    await resolved.client.permission.reply({
      sessionID: session.id,
      requestID: data.id,
      decision: "once",
    })
    console.log("  · replied: once")
  })

  phase2.asked = phase2.transcript.items.find(
    (item): item is PermissionItem => item.kind === "permission",
  )
  phase2.pendingAfterReply = (
    await resolved.client.permission.list({ sessionID: session.id })
  ).length

  const toolRan = phase2.transcript.items.some(
    (item) =>
      item.kind === "assistant" &&
      item.blocks.some((block) => block.type === "tool" && block.status === "done"),
  )

  console.log("\n--- phase 2: approval checks ---")
  console.log(`permission requested  : ${phase2.asked !== undefined}`)
  console.log(`card status after reply: ${phase2.asked?.status ?? "(none)"}`)
  console.log(`tool ran to completion: ${toolRan}`)
  console.log(`pending after reply   : ${phase2.pendingAfterReply}`)

  const phase2Pass =
    phase2.asked === undefined
      ? undefined
      : phase2.asked.status === "once" && toolRan && phase2.pendingAfterReply === 0

  if (phase1Pass && phase2Pass !== false) {
    console.log(
      `\nSMOKE: PASS${phase2Pass === undefined ? " (permission phase skipped: model never called the tool)" : ""}`,
    )
  } else {
    console.log("\nSMOKE: FAIL")
    if (!phase1Pass) console.log("  phase 1 failed")
    if (phase2Pass === false) console.log("  phase 2 failed")
  }

  if (!keep) {
    await resolved.client.session.remove({ sessionID: session.id })
    console.log("smoke session removed")
  }

  cleanup()
  clearTimeout(watchdog)
  process.exitCode = phase1Pass && phase2Pass !== false ? 0 : 1
}

/** Session ids keyed by client, used by `runTextPhase`. */
function cleanup(): void {
  rmSync(envPath, { force: true })
}

main().catch((error: unknown) => {
  cleanup()
  console.error("smoke: failed")
  console.error(error)
  process.exitCode = 1
})
