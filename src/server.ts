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
  /** Absolute directory the panel works in. Sent as `x-opencode-directory`. */
  readonly directory: string
  /** Explicit server URL from settings; empty means auto-discover. */
  readonly overrideUrl?: string
  readonly log?: (message: string) => void
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

/**
 * Find the OpenCode server for this window.
 *
 * Order: an explicit URL from settings, then the registered background service,
 * then starting one (`opencode serve --service`) when none is running.
 */
export async function resolveClient(options: ResolveOptions): Promise<ResolvedClient> {
  const log = options.log ?? (() => {})
  const directory = options.directory
  const override = options.overrideUrl?.trim() ?? ""

  if (override.length > 0) {
    log(`Using configured server URL ${override}`)
    return {
      client: OpenCode.make({
        baseUrl: override,
        headers: { "x-opencode-directory": directory },
      }),
      url: override,
      directory,
      authenticated: false,
    }
  }

  let endpoint: Endpoint | undefined = await Service.discover({ version: isCompatibleVersion })
  if (!endpoint) {
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
