import { OpenCode } from "@opencode/client"
import type { OpenCodeClient } from "@opencode/client"
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
