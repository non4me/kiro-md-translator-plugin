import { TranslatorError } from '../types'
import { t } from '../l10n'

/**
 * Map any thrown error into the localized, user-facing AI-Assistant message
 * required by req 17. Single point of truth so every catch site (the session
 * stream, provider build, apply, summary-save) emits identical wording.
 *
 * - Transport failures (HTTP, timeout, empty body, bare `fetch` rejects) →
 *   `Connection failed: {detail}` (req 17.5).
 * - Malformed model output (`SyntaxError` from JSON parsing) →
 *   `Failed to parse AI response` (req 17.6).
 * - Provider-availability / missing-key errors are already fully worded at the
 *   throw site (`API key required for {0}` 17.2, the Copilot 17.3 and Kiro 17.4
 *   strings) and pass through unchanged — never re-wrapped (no double `t()`).
 */
export function assistantErrorMessage(err: unknown): string {
  if (err instanceof TranslatorError) {
    switch (err.code) {
      case 'TRANSLATION_HTTP_ERROR':
      case 'TRANSLATION_TIMEOUT':
      case 'TRANSLATION_EMPTY_RESPONSE':
        return t('Connection failed: {0}', err.message)
      default:
        // INVALID_ENDPOINT_URL (key/provider messages) is already req-17 wording.
        return err.message
    }
  }
  if (err instanceof SyntaxError) return t('Failed to parse AI response')
  const e = err as Error | undefined
  const msg = e?.message ?? ''
  // A bare network rejection surfaces as a TypeError ("fetch failed") or an
  // errno-tagged message — treat those as a connection failure too.
  if (e?.name === 'TypeError' || /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|timed out/i.test(msg)) {
    return t('Connection failed: {0}', msg || 'network error')
  }
  return msg || t('Connection failed: {0}', 'unknown error')
}
