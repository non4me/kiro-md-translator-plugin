import type * as vscode from 'vscode'
import { ActivationController } from './ActivationController'

let controller: ActivationController | undefined

export function activate(context: vscode.ExtensionContext): void {
  controller = new ActivationController()
  controller.activate(context)
}

export function deactivate(): Thenable<void> | void {
  // Return the persist Thenable so VS Code awaits the translation-memory flush
  // before the extension host shuts down (req 9.6).
  return controller?.deactivate()
}
