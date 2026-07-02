import { TranslatorError } from '../types'

/** Wraps `fetch` with a hard timeout, mapping aborts to a typed timeout error. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)

  // Forward an externally-supplied abort into our controller.
  const onAbort = () => timeoutController.abort()
  signal?.addEventListener('abort', onAbort)

  try {
    return await fetch(url, { ...init, signal: timeoutController.signal })
  } catch (err) {
    if (timeoutController.signal.aborted && !signal?.aborted) {
      throw new TranslatorError('TRANSLATION_TIMEOUT', 'Request timed out')
    }
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Throws a typed HTTP error for non-2xx responses. */
export async function ensureOk(response: Response): Promise<Response> {
  if (!response.ok) {
    let detail = ''
    try {
      detail = await response.text()
    } catch {
      /* ignore */
    }
    throw new TranslatorError(
      'TRANSLATION_HTTP_ERROR',
      `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      response.status,
    )
  }
  return response
}

/** Splits an array into chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
