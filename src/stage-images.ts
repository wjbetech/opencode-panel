import * as vscode from "vscode"

/**
 * An image pasted or dropped into the composer, as the webview reports it.
 *
 * `dataUrl` is a `data:image/…;base64,…` URL; the server only accepts URIs,
 * so the host stages the bytes to disk at send time (see `stageImages`).
 * `mention` is the `@token` span written into the prompt text so the server
 * can link the reference.
 */
export type StagedImage = {
  name: string
  dataUrl: string
  mention?: { start: number; end: number; text: string }
}

/** Keep only well-formed image payloads from a webview `prompt` message. */
export function readStagedImages(value: unknown): StagedImage[] {
  if (!Array.isArray(value)) return []
  const images: StagedImage[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = typeof record.name === "string" ? record.name : ""
    const dataUrl = typeof record.dataUrl === "string" ? record.dataUrl : ""
    if (name.length === 0 || !dataUrl.startsWith("data:image/")) continue
    const mention = record.mention as { start?: unknown; end?: unknown; text?: unknown } | undefined
    if (
      mention &&
      typeof mention.start === "number" &&
      typeof mention.end === "number" &&
      typeof mention.text === "string"
    ) {
      images.push({ name, dataUrl, mention: { start: mention.start, end: mention.end, text: mention.text } })
    } else {
      images.push({ name, dataUrl })
    }
  }
  return images
}

/** Staged images are refused above this size; the webview filters first, this is the backstop. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024

/**
 * Write pasted/dropped images to disk so they can be attached as prompt files.
 *
 * Files land under `<globalStorage>/opencode-images/` keyed by their (already
 * unique) token name, and come back as `file://` URIs the server can read.
 * Images that are too large or not decodable are skipped with a log line.
 */
export async function stageImages(
  storage: vscode.Uri,
  images: StagedImage[],
  log: (message: string) => void,
): Promise<Array<{ uri: string; name: string; mention?: { start: number; end: number; text: string } }>> {
  const staged: Array<{ uri: string; name: string; mention?: { start: number; end: number; text: string } }> = []
  if (images.length === 0) return staged

  const dir = vscode.Uri.joinPath(storage, "opencode-images")
  try {
    await vscode.workspace.fs.createDirectory(dir)
  } catch (error) {
    log(`Could not create image staging dir: ${error instanceof Error ? error.message : String(error)}`)
    return staged
  }

  for (const image of images) {
    try {
      const match = image.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s)
      if (!match) continue
      const bytes = Buffer.from(match[2] ?? "", "base64")
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        log(`Skipping staged image ${image.name}: ${bytes.length} bytes`)
        continue
      }
      const safe = image.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "image.png"
      const file = vscode.Uri.joinPath(dir, safe)
      await vscode.workspace.fs.writeFile(file, bytes)
      staged.push({ uri: file.toString(), name: image.name, ...(image.mention ? { mention: image.mention } : {}) })
    } catch (error) {
      log(`Could not stage image ${image.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return staged
}
