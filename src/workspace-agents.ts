import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"

/**
 * A custom agent file from the workspace, as the agent picker shows it.
 *
 * `id` is `workspace:<name>`; `file` is the absolute path; `content` is the
 * body with frontmatter stripped, applied as session instructions.
 */
export type WorkspaceAgentFile = {
  id: string
  name: string
  description: string
  file: string
  content: string
}

/** Folders scanned, in order: current `.github/agents`, then legacy chatmodes. */
const SCAN_TARGETS = [
  { dir: ".github/agents", suffix: ".agent.md" },
  { dir: ".github/chatmodes", suffix: ".chatmode.md" },
] as const

/**
 * Scan a workspace folder for custom agent files.
 *
 * Cheap (one or two `readdir`s plus one read per match), so the caller
 * re-scans on every Refresh: saving a file then hitting Refresh picks it up
 * with no restart.
 */
export async function scanWorkspaceAgents(directory: string): Promise<WorkspaceAgentFile[]> {
  const found: WorkspaceAgentFile[] = []
  const seen = new Set<string>()
  for (const target of SCAN_TARGETS) {
    const folder = path.join(directory, target.dir)
    let entries: string[]
    try {
      entries = await readdir(folder)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(target.suffix)) continue
      const name = entry.slice(0, -target.suffix.length)
      if (name.length === 0 || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      const file = path.join(folder, entry)
      let text: string
      try {
        text = await readFile(file, "utf8")
      } catch {
        continue
      }
      const { description, content } = splitFrontmatter(text)
      found.push({
        id: `workspace:${name}`,
        name,
        description,
        file,
        content: content.length > 0 ? content : text,
      })
    }
  }
  found.sort((left, right) => left.name.localeCompare(right.name))
  return found
}

/** Split `---\ndescription: …\n---\nbody` frontmatter; tolerant of its absence. */
function splitFrontmatter(text: string): { description: string; content: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { description: "", content: text.trim() }
  const description = (/^description\s*:\s*(.+)$/m.exec(match[1] ?? "")?.[1] ?? "").trim().replace(/^["']|["']$/g, "")
  return { description, content: (match[2] ?? "").trim() }
}
