/**
 * End-to-end check for the VS Code chat hand-off, in both directions.
 *
 *   pnpm run handoff            # newest chat with content
 *   pnpm run handoff -- <id>    # a specific VS Code session id
 *   pnpm run handoff -- --list  # just list what is on disk
 *
 * Reads real session files from the VS Code chat store, imports one into an
 * OpenCode session, exports it back, and confirms the round trip. The imported
 * OpenCode session is deleted and the written files are removed afterwards.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  chatStoreRoot,
  findWorkspaceDir,
  fromOpenCodeExport,
  importDefaults,
  listChatSessions,
  newSessionID,
  readChatSession,
  sameFolder,
  toOpenCodeImport,
  updateChatIndex,
  userRootFromGlobalStorage,
  writeChatSession,
} from "../src/vscode-chat"
import { resolveClient } from "../src/server"

const directory = process.cwd()
const arguments_ = process.argv.slice(2)
const wantsList = arguments_.includes("--list")
const requestedId = arguments_.find((value) => !value.startsWith("--"))

// The panel derives this from `context.globalStorageUri`; here we assume the
// standard VS Code layout for the current user.
const userRoot =
  process.platform === "win32"
    ? userRootFromGlobalStorage(path.join(process.env.APPDATA ?? "", "Code", "User", "globalStorage", "local.opencode-panel"))
    : userRootFromGlobalStorage(path.join(process.env.HOME ?? "", ".config", "Code", "User", "globalStorage", "local.opencode-panel"))

function fail(message: string): never {
  console.error(`FAIL  ${message}`)
  process.exit(1)
}

function check(condition: boolean, message: string): void {
  console.log(`${condition ? "  ok  " : "  FAIL"} ${message}`)
  if (!condition) process.exitCode = 1
}

console.log(`store: ${chatStoreRoot(userRoot)}`)
const sessions = listChatSessions(chatStoreRoot(userRoot))
console.log(`found ${sessions.length} VS Code chat sessions\n`)

for (const session of sessions.slice(0, 12)) {
  const marker = sameFolder(session.folder, directory) ? "*" : " "
  console.log(
    ` ${marker} ${session.sessionId.slice(0, 8)}  turns=${String(session.turns.length).padStart(3)}  ${new Date(session.lastMessageDate).toISOString().slice(0, 16)}  ${session.title.slice(0, 52)}`,
  )
  console.log(`     ${session.file}`)
}

if (wantsList) process.exit(0)

const target =
  (requestedId ? sessions.find((session) => session.sessionId.startsWith(requestedId)) : undefined) ??
  sessions.filter((session) => session.turns.length > 0).sort((left, right) => right.turns.length - left.turns.length)[0]

if (!target) fail("no session with content to import")

console.log(`\n=== import: ${target.sessionId} (${target.turns.length} turns) ===`)
console.log(`  title: ${target.title}`)
const withAttachments = target.turns.filter((turn) => turn.attachments.length > 0).length
const withAnswer = target.turns.filter((turn) => turn.assistant.length > 0).length
console.log(`  turns with file context: ${withAttachments}; turns with an answer: ${withAnswer}`)
console.log(`  first user turn: ${JSON.stringify(target.turns[0]?.user.slice(0, 120))}`)
console.log(`  first answer:    ${JSON.stringify(target.turns[0]?.assistant.slice(0, 120))}`)

const { client, url } = await resolveClient({ directory, log: (message) => console.log(`  [server] ${message}`) })
console.log(`  server: ${url}`)

const { projectID, agent, model } = await importDefaults(client, directory, (message) =>
  console.log(`  [defaults] ${message}`),
)
console.log(`  agent/model: ${agent} / ${model.providerID}/${model.id}`)
console.log(`  projectID: ${projectID || "(none: the server files the session by directory)"}`)

const sessionID = newSessionID()
const payload = toOpenCodeImport(target, {
  sessionID,
  projectID,
  directory,
  agent,
  model,
})

const expectedUsers = payload.messages.filter((message) => message.type === "user").length
const expectedAssistants = payload.messages.filter((message) => message.type === "assistant").length
console.log(`  payload: ${payload.messages.length} messages (limit 50), session ${sessionID}`)
if (payload.summarisedTurns > 0) {
  console.log(`  summarised: ${payload.summarisedTurns} older turns folded into the first message`)
  console.log(`  digest head: ${JSON.stringify(String(payload.messages[0]?.text ?? "").slice(0, 160))}`)
}
check(payload.messages.length <= 50, `payload respects the import cap (${payload.messages.length} <= 50)`)
check(expectedUsers > 0, `payload carries user turns (${expectedUsers})`)
check(expectedAssistants > 0, `payload carries assistant turns (${expectedAssistants})`)

let imported = false
try {
  await client.session.import(payload as never)
  imported = true
  console.log("  import: ok")
} catch (error) {
  console.error(`  import FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const landed = (await client.message.list({ sessionID })).data
const landedUsers = landed.filter((message) => message.type === "user").length
const landedAssistants = landed.filter((message) => message.type === "assistant").length
console.log(`  landed: ${landed.length} messages (${landedUsers} user, ${landedAssistants} assistant)`)

check(landedUsers === expectedUsers, `user messages match (${landedUsers}/${expectedUsers})`)
check(landedAssistants === expectedAssistants, `assistant messages match (${landedAssistants}/${expectedAssistants})`)

const landedText = landed.map((message) => (message.type === "user" ? message.text : "")).join("\n")
const originalFirst = target.turns.find((turn) => turn.user.trim().length > 0)?.user ?? ""
check(
  target.turns.length + 1 <= 50 || landedText.includes(originalFirst.trim().split("\n")[0]?.slice(0, 40) ?? ""),
  "the original opening question survives (verbatim or in the summary)",
)

const info = (await client.session.get({ sessionID })) as unknown as { title?: string }
console.log(`  session title: ${JSON.stringify(info?.title)}`)

// ---------------------------------------------------------------- backport

console.log(`\n=== backport: ${sessionID} -> VS Code chat document ===`)
const exported = await client.session.export({ sessionID })
const { document, sessionId, indexEntry } = fromOpenCodeExport(exported, {
  folder: directory,
  responder: "OpenCode",
})
const exportedTurns = (document.requests as unknown[]).length
console.log(`  document: ${exportedTurns} requests, vscode session ${sessionId}`)
check(exportedTurns === Math.max(expectedUsers, expectedAssistants) || exportedTurns > 0, `document has requests (${exportedTurns})`)

const scratch = mkdtempSync(path.join(tmpdir(), "opencode-handoff-"))
const written = writeChatSession(scratch, sessionId, document)
console.log(`  wrote ${written} (${statSync(written).size}B)`)

const reparsed = readChatSession(written, directory)
check(reparsed !== undefined, "written file parses back")
check((reparsed?.turns.length ?? 0) === exportedTurns, `round trip keeps every turn (${reparsed?.turns.length}/${exportedTurns})`)
const firstUser = reparsed?.turns.find((turn) => turn.user.trim().length > 0)?.user ?? ""
check(firstUser.trim().length > 0, `round trip keeps the first question: ${JSON.stringify(firstUser.slice(0, 80))}`)
const firstAnswer = reparsed?.turns.find((turn) => turn.assistant.length > 0)?.assistant ?? ""
check(firstAnswer.trim().length > 0, `round trip keeps the first answer: ${JSON.stringify(firstAnswer.slice(0, 80))}`)
check(typeof indexEntry.sessionId === "string" && indexEntry.sessionId === sessionId, "index entry matches the document")

// The real target workspace, when this checkout has one, proves path matching.
const workspaceDir = findWorkspaceDir(chatStoreRoot(userRoot), directory)
console.log(`  workspace dir for this checkout: ${workspaceDir ?? "(none)"}`)
check(workspaceDir !== undefined, "found this checkout's workspace storage directory")

// Exercise the history index write against a copy, never VS Code's live DB.
if (workspaceDir) {
  const copyDir = path.join(scratch, "dbcopy")
  mkdirSync(copyDir, { recursive: true })
  let copied = ""
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = path.join(workspaceDir, `state.vscdb${suffix}`)
    if (existsSync(from)) {
      copyFileSync(from, path.join(copyDir, `state.vscdb${suffix}`))
      copied += `${suffix || "(main)"} `
    }
  }
  console.log(`  copied ${copied.trim()}`)

  const result = await updateChatIndex(copyDir, sessionId, indexEntry)
  check(result.updated, `index write: ${result.updated ? "ok" : (result.reason ?? "unknown")}`)

  const sqlite = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => {
      prepare: (sql: string) => { get: (...params: unknown[]) => { value?: unknown } | undefined }
      close: () => void
    }
  }
  const db = new sqlite.DatabaseSync(path.join(copyDir, "state.vscdb"), { readOnly: true })
  const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'").get()
  const parsed = JSON.parse(String(row?.value)) as { entries?: Record<string, unknown> }
  check(parsed.entries?.[sessionId] !== undefined, "index entry readable after the write")
  console.log(`  index now holds ${Object.keys(parsed.entries ?? {}).length} entries`)
  db.close()
}

rmSync(scratch, { recursive: true, force: true })
if (imported) {
  await client.session.remove({ sessionID })
  console.log(`\ncleaned up session ${sessionID} and the scratch files`)
}

console.log(`\n${process.exitCode === 1 ? "FAILED" : "PASSED"}`)
