import * as vscode from "vscode"
import { DevReloader } from "./dev"
import { PanelController, VIEW_ID } from "./panel"
import { ChatSessions } from "./sessions"

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("OpenCode Panel")
  context.subscriptions.push(output)

  // Registers the OpenCode sessions with the Chat Sessions view. This is a
  // proposed API, so it only does anything when VS Code enables it for this
  // extension (see scripts/enable-proposed-api.mjs).
  const sessions = new ChatSessions(context, output)
  sessions.register()

  const controller = new PanelController(context, output, sessions)

  context.subscriptions.push(
    controller,
    // The pane is a webview view in the secondary sidebar, the same place the
    // default Chat view lives. VS Code resolves it the first time it is shown.
    vscode.window.registerWebviewViewProvider(VIEW_ID, controller, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("opencodePanel.open", () => controller.open()),
    vscode.commands.registerCommand("opencodePanel.newSession", () => controller.open({ startNew: true })),
    vscode.commands.registerCommand("opencodePanel.pickSession", () => controller.pickSession()),
    vscode.commands.registerCommand("opencodePanel.refresh", () => controller.refresh()),
    vscode.commands.registerCommand("opencodePanel.reloadWebview", () => controller.reloadWebview()),
    vscode.commands.registerCommand("opencodePanel.importChat", () => controller.importChatSession()),
    vscode.commands.registerCommand("opencodePanel.backportChat", () => controller.backportChatSession()),
    vscode.commands.registerCommand("opencodePanel.openInChat", () => controller.openSessionInChat()),
    vscode.commands.registerCommand("opencodePanel.showStatus", () => controller.showDiagnostics()),
  )

  // Development builds watch esbuild's output and push rebuilds straight into
  // the open pane, so a change lands without reloading the window. Extension
  // host code still needs a host restart, which the pane survives.
  const dev =
    context.extensionMode === vscode.ExtensionMode.Development || process.env.OPENCODE_PANEL_DEV === "1"
  if (dev) {
    output.appendLine("[dev] hot reload on - edits to dist/webview.js and media/panel.css reload the pane")
    context.subscriptions.push(new DevReloader(context, output, () => controller.reloadWebview()))
  }
}

export function deactivate(): void {
  // Nothing to clean up: resources are owned by the extension context.
}
