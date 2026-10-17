import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Development-only hot reload.
 *
 * `pnpm run watch` keeps esbuild rebuilding `dist/`, and this class pushes those
 * rebuilds into the running editor so a change lands without reloading the
 * window:
 *
 * - `dist/webview.js` and `media/panel.css` are re-loaded into the open pane.
 *   The webview document is replaced, but the extension host keeps running, so
 *   the session, the event stream and the transcript survive.
 * - `dist/extension.js` cannot be re-required in a live host. That change can
 *   only be reported: restarting the extension host (or the F5 session) loads
 *   it, which is far cheaper than reloading the whole window. The pane is
 *   restored by VS Code afterwards.
 *
 * The directories are watched with Node's own `fs.watch` rather than VS Code's
 * file watcher service: the extension folder is not always part of the open
 * workspace (for example when `OPENCODE_PANEL_DEV=1` drives an installed build),
 * and `fs.watch` is not limited to workspace folders.
 */
export class DevReloader implements vscode.Disposable {
  private readonly watchers: fs.FSWatcher[] = []
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    onWebviewChange: () => void,
  ) {
    const log = (message: string): void => {
      output.appendLine(`[${new Date().toISOString()}] ${message}`)
    }

    // Coalesce a burst of writes (esbuild emits the bundle and its map) into a
    // single handler call.
    const debounce = (handler: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      return (): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
          this.timers.delete(timer)
        }
        const next = setTimeout(() => {
          this.timers.delete(next)
          timer = undefined
          handler()
        }, 120)
        timer = next
        this.timers.add(next)
      }
    }

    const webviewChanged = debounce(() => {
      log("Panel assets rebuilt - reloading the pane")
      onWebviewChange()
    })
    const hostChanged = debounce(() => {
      log("Extension host bundle rebuilt - restart the extension host to load it")
    })

    const watchDir = (dir: string, onFile: (file: string) => void): void => {
      let watcher: fs.FSWatcher
      try {
        watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
          const name = filename ? filename.toString() : ""
          if (name.length > 0) onFile(path.basename(name))
        })
      } catch (error) {
        log(`Could not watch ${dir} for hot reload: ${messageOf(error)}`)
        return
      }
      watcher.on("error", (error) => log(`Hot reload watcher on ${dir} failed: ${messageOf(error)}`))
      this.watchers.push(watcher)
    }

    const root = context.extensionUri.fsPath
    watchDir(path.join(root, "dist"), (file) => {
      if (file === "webview.js") webviewChanged()
      else if (file === "extension.js") hostChanged()
    })
    watchDir(path.join(root, "media"), (file) => {
      if (file === "panel.css") webviewChanged()
    })
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const watcher of this.watchers) watcher.close()
    this.watchers.length = 0
  }
}
