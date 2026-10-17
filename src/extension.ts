import * as vscode from "vscode"
import { PanelController } from "./panel"
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
    vscode.commands.registerCommand("opencodePanel.open", () => controller.open()),
    vscode.commands.registerCommand("opencodePanel.newSession", () => controller.open({ startNew: true })),
    vscode.commands.registerCommand("opencodePanel.pickSession", () => controller.pickSession()),
    vscode.commands.registerCommand("opencodePanel.importChat", () => controller.importChatSession()),
    vscode.commands.registerCommand("opencodePanel.backportChat", () => controller.backportChatSession()),
    vscode.commands.registerCommand("opencodePanel.openInChat", () => controller.openSessionInChat()),
    vscode.commands.registerCommand("opencodePanel.showStatus", () => controller.showDiagnostics()),
  )
}

export function deactivate(): void {
  // Nothing to clean up: resources are owned by the extension context.
}
