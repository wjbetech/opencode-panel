import { OpenCode } from "@opencode/client"
import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { Endpoint } from "@opencode/client/service"

/** A ready-to-use client plus the details worth showing in diagnostics. */
export type ResolvedClient = {
  readonly client: OpenCodeClient
  readonly url: string
  readonly directory: string
  readonly authenticated: boolean
}

export type ResolveOptions = {
  /** Absolute directory of the local workspace; sent as `x-opencode-directory` unless overridden. */
  readonly directory: string
  /** Explicit server URL from settings; empty means auto-discover. */
  readonly overrideUrl?: string
  /** Password for a remote server; empty means none. Userinfo in the URL wins over this. */
  readonly password?: string
  /**
   * Directory as seen by a remote server (where agent tools run).
   * When set with `overrideUrl`, it replaces `directory` for scoping.
   */
  readonly remoteDirectory?: string
  /**
   * Start a detached background service when none is registered (default true).
   * Pass false on Windows: a detached service is console-less, so every shell
   * the agent runs pops a visible PowerShell window. The caller is expected to
   * offer the terminal server instead (see `NoServerAvailableError`).
   */
  readonly autoStart?: boolean
  readonly log?: (message: string) => void
}

/** Nothing registered and auto-start is off: the caller should offer the terminal server. */
export class NoServerAvailableError extends Error {
  constructor() {
    super("No OpenCode server is running")
    this.name = "NoServerAvailableError"
  }
}

/** Any 2.x server speaks the client's contract; other majors are refused. */
function isCompatibleVersion(version: string): boolean {
  return version.startsWith("2.")
}

/** How many sessions one unscoped page asks for; see `listSessions`. */
const SCAN_LIMIT = 100

/**
 * Sessions belonging to one directory, newest first.
 *
 * `session.list({ directory })` cannot be used: the client turns its input into
 * a query string and backslashes do not survive it (`C:\Users\me` arrives as
 * `C:Usersme`), which the server answers with a 500. The list is fetched
 * unscoped and matched here instead. Comparison ignores case and slash
 * direction, because the same folder arrives as `c:\…` from VS Code and
 * `C:\…` from the server's own records.
 *
 * Only one page is fetched, so a directory whose sessions are all older than the
 * newest `SCAN_LIMIT` server-wide will look empty.
 */
export async function listSessions(
  client: OpenCodeClient,
  directory: string,
  options: { limit?: number; scan?: number } = {},
): Promise<SessionInfo[]> {
  const response = await client.session.list({ limit: options.scan ?? SCAN_LIMIT, order: "desc" })
  const data = Array.isArray(response) ? response : response.data
  return data
    .filter((session) => sameDirectory(session.location?.directory, directory))
    .slice(0, options.limit ?? 50)
}

export function sameDirectory(left: string | undefined, right: string): boolean {
  if (typeof left !== "string" || left.length === 0) return false
  return normalizeDirectory(left) === normalizeDirectory(right)
}

function normalizeDirectory(directory: string): string {
  return directory.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
}

/** Strip `user:password@` from a server URL, returning the clean URL plus credentials. */
function splitUserinfo(raw: string): { url: string; username: string; password: string | undefined } {
  try {
    const parsed = new URL(raw)
    const username = decodeURIComponent(parsed.username ?? "")
    const password = parsed.password.length > 0 ? decodeURIComponent(parsed.password) : undefined
    parsed.username = ""
    parsed.password = ""
    return { url: parsed.toString().replace(/\/$/, ""), username, password }
  } catch {
    return { url: raw, username: "", password: undefined }
  }
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function normalizeServerUrl(raw: string): string {
  let trimmed = raw.trim()
  if (trimmed.length === 0) throw new Error("Server URL is empty")
  // Common typo: http://1.2.3.4.4096 (dot instead of colon before port)
  // Detect IP + dot + port with scheme and fix it before validation.
  const malformedIpPort = trimmed.match(/^(https?:\/\/\d+\.\d+\.\d+\.\d+)\.(\d+)(\/.*)?$/)
  if (malformedIpPort) {
    trimmed = `${malformedIpPort[1]}:${malformedIpPort[2]}${malformedIpPort[3] ?? ""}`
  }
  // Bare host:port without scheme is common (e.g. "127.0.0.1:4096").
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  if (!isValidUrl(withScheme)) {
    throw new Error(`Invalid server URL "${raw}" - ${withScheme} is not a valid URL`)
  }
  return withScheme
}

/** The registered local service, if one answers. Says nothing about consoles. */
export async function discoverService(): Promise<Endpoint | undefined> {
  return Service.discover({ version: isCompatibleVersion })
}

/**
 * Stop the registered local service (SIGTERMs its pid).
 *
 * The usual target is a console-less background service left behind by a GUI
 * app: every shell such a server spawns gets a fresh visible console window.
 */
export async function stopService(): Promise<void> {
  await Service.stop()
}

/**
 * Find the OpenCode server for this window.
 *
 * Order: an explicit URL from settings, then the registered background service,
 * then starting one (`opencode serve --service`) when none is running —
 * unless `autoStart` is false (Windows), which throws `NoServerAvailableError`
 * instead of spawning the flashing console-less service.
 *
 * Remote mode (explicit URL): auth is HTTP Basic `opencode:<password>`, the
 * same scheme the local service uses. The password comes from userinfo in the
 * URL (`http://opencode:secret@host:port`) or from the `password` option, and
 * `remoteDirectory` replaces the local folder because agent tools run where
 * the server runs.
 */
export async function resolveClient(options: ResolveOptions): Promise<ResolvedClient> {
  const log = options.log ?? (() => {})
  const directory = options.directory
  const override = options.overrideUrl?.trim() ?? ""

  if (override.length > 0) {
    let normalized: string
    try {
      normalized = normalizeServerUrl(override)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${message}. Check the "opencodePanel.serverUrl" setting (currently "${override}"). Expected something like "http://127.0.0.1:4096".`,
      )
    }
    const { url, username, password: urlPassword } = splitUserinfo(normalized)
    const password = urlPassword ?? options.password?.trim() ?? ""
    const effectiveDirectory = options.remoteDirectory?.trim() || directory
    const headers: Record<string, string> = { "x-opencode-directory": effectiveDirectory }
    if (password.length > 0) {
      const user = username.length > 0 ? username : "opencode"
      headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
    } else {
      log("No remote password configured; connecting unauthenticated")
    }
    log(`Using configured server URL ${url}`)
    if (normalized !== override) log(`(setting was "${override}")`)
    if (effectiveDirectory !== directory) log(`Scoping sessions to remote directory ${effectiveDirectory}`)
    return {
      client: OpenCode.make({ baseUrl: url, headers }),
      url,
      directory: effectiveDirectory,
      authenticated: password.length > 0,
    }
  }

  let endpoint: Endpoint | undefined = await Service.discover({ version: isCompatibleVersion })
  if (!endpoint) {
    if ((options.autoStart ?? true) === false) {
      log("No running service found and auto-start is off (Windows: avoids the flashing console-less service)")
      throw new NoServerAvailableError()
    }
    log("No running service found; starting one")
    endpoint = await Service.ensure({
      version: isCompatibleVersion,
      onStart(reason) {
        log(`Service start requested (${reason})`)
      },
    })
  }

  if (!endpoint) {
    throw new Error(
      "No OpenCode server is available. Start OpenCode in a terminal, or set `opencodePanel.serverUrl`.",
    )
  }

  const auth = Service.headers(endpoint)
  log(`Connected to ${endpoint.url} (authenticated: ${auth ? "yes" : "no"})`)

  return {
    client: OpenCode.make({
      baseUrl: endpoint.url,
      headers: { ...(auth ?? {}), "x-opencode-directory": directory },
    }),
    url: endpoint.url,
    directory,
    authenticated: Boolean(auth),
  }
}
