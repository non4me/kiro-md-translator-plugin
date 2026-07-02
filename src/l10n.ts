import * as vscode from 'vscode'

/**
 * Resolve a user-facing string through `vscode.l10n` (req 8). The Russian
 * source strings passed here are the reference-catalog values; per-locale
 * bundles in `l10n/` override them, and missing keys fall back to the source.
 * When `vscode.l10n` is unavailable (e.g. unit tests), we substitute the
 * `{0}`/`{1}` placeholders ourselves so behaviour is identical.
 */
export function t(message: string, ...args: Array<string | number | boolean>): string {
  const api = (vscode as unknown as { l10n?: { t?: (m: string, ...a: unknown[]) => string } }).l10n
  if (api && typeof api.t === 'function') {
    return api.t(message, ...args)
  }
  return message.replace(/\{(\d+)\}/g, (_match, index: string) => {
    const value = args[Number(index)]
    return value === undefined ? `{${index}}` : String(value)
  })
}
