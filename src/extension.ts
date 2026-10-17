import * as vscode from "vscode"
import { PanelController } from "./panel"

export function activate(context: vscode.ExtensionContext): void {
  const controller = new PanelController(context)

  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand("opencodePanel.open", () => controller.open()),
    vscode.commands.registerCommand("opencodePanel.newSession", () => controller.open({ startNew: true })),
    vscode.commands.registerCommand("opencodePanel.pickSession", () => controller.pickSession()),
    vscode.commands.registerCommand("opencodePanel.importChat", () => controller.importChatSession()),
    vscode.commands.registerCommand("opencodePanel.backportChat", () => controller.backportChatSession()),
    vscode.commands.registerCommand("opencodePanel.showStatus", () => controller.showDiagnostics()),
  )
}

export function deactivate(): void {
  // Nothing to clean up: resources are owned by the extension context.
}
