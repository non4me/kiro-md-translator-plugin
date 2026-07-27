import * as vscode from 'vscode'

/**
 * Format a user-facing string. The UI is English-only — req 8 (localization) is
 * withdrawn and no message catalog ships — so the English literal passed here is
 * what the user sees, and this is a `{0}`/`{1}` placeholder formatter, not a
 * translation lookup. It stays because a single funnel means a future catalog
 * could be introduced without touching a call site.
 *
 * `vscode.l10n.t` is used when the API exists (without bundles it returns the
 * source string, so the result is the same); when it is absent (unit tests) we
 * substitute the placeholders ourselves, keeping behaviour identical either way.
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
