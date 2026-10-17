#!/usr/bin/env node
/**
 * Let VS Code hand this extension the proposed chat session API.
 *
 * VS Code only exposes proposed APIs to extensions named in its own
 * `product.json` (`extensionEnabledApiProposals`) - the same list that enables
 * `chatSessionsProvider` for GitHub.copilot-chat and `openai.chatgpt`. The
 * extension cannot ask for it in its own manifest: declaring a proposal that
 * `product.json` does not grant makes VS Code refuse to activate the whole
 * extension. So the manifest stays silent and this script grants the API from
 * the side that VS Code trusts.
 *
 * A VS Code update replaces `product.json`, so re-run this after updating.
 * `pnpm run enable-proposed-api -- --check` only reports the current state.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

/** Proposals the Chat Sessions view needs: item/content provider + turn classes. */
const PROPOSALS = ["chatSessionsProvider", "chatParticipantPrivate"]

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const extensionID = `${manifest.publisher}.${manifest.name}`

const checkOnly = process.argv.includes("--check")
const explicit = argument("--product") ?? argument("--install")

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) fail(`${name} needs a path`)
  return value
}

function fail(message) {
  console.error(`enable-proposed-api: ${message}`)
  process.exit(1)
}

/** `<install>/resources/app/product.json` for the `code` shim on PATH. */
function candidateProducts() {
  if (explicit) {
    const asFolder = path.join(explicit, "resources", "app", "product.json")
    return existsSync(explicit) && explicit.endsWith("product.json") ? [explicit] : [asFolder]
  }

  const finder = process.platform === "win32" ? ["where", ["code"]] : ["which", ["-a", "code"]]
  let output = ""
  try {
    output = execFileSync(finder[0], finder[1], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    fail("could not find `code` on PATH; pass --product <path to product.json>")
  }

  const installs = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((shim) => path.dirname(path.dirname(shim)))

  // Windows builds keep the app in a commit-named folder next to `bin/`.
  const products = []
  for (const install of installs) {
    products.push(path.join(install, "resources", "app", "product.json"))
    let entries = []
    try {
      entries = readdirSync(install, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        products.push(path.join(install, entry.name, "resources", "app", "product.json"))
      }
    }
  }
  return products
}

const productPath = candidateProducts().find((file) => existsSync(file))
if (!productPath) fail(`no product.json found (looked at ${candidateProducts().join(", ")})`)

const raw = readFileSync(productPath, "utf8")
const product = JSON.parse(raw)
product.extensionEnabledApiProposals = product.extensionEnabledApiProposals ?? {}

const current = product.extensionEnabledApiProposals[extensionID] ?? []
const wanted = PROPOSALS.filter((proposal) => !current.includes(proposal))

console.log(`VS Code: ${productPath}`)
console.log(`Extension: ${extensionID}`)
console.log(`Currently granted: ${current.length > 0 ? current.join(", ") : "(nothing)"}`)

if (wanted.length === 0) {
  console.log("Already enabled - nothing to do.")
  process.exit(0)
}

if (checkOnly) {
  console.log(`Missing: ${wanted.join(", ")}`)
  console.log("Run `pnpm run enable-proposed-api` to add them.")
  process.exit(1)
}

const indent = raw.includes("\n\t") ? "\t" : "  "
product.extensionEnabledApiProposals[extensionID] = [...current, ...wanted]
writeFileSync(productPath, `${JSON.stringify(product, null, indent)}\n`)

console.log(`Added: ${wanted.join(", ")}`)
console.log("Restart VS Code (all windows) for this to take effect.")
