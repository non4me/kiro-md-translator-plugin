import { describe, it, expect, vi, afterEach } from 'vitest'
import fc from 'fast-check'
import { isValidEndpoint } from '../src/providers/urlValidation'
import { DeepLProvider } from '../src/providers/DeepLProvider'
import { GoogleTranslateProvider } from '../src/providers/GoogleTranslateProvider'
import { CustomHttpProvider } from '../src/providers/CustomHttpProvider'
import { fetchWithTimeout } from '../src/providers/http'

afterEach(() => vi.unstubAllGlobals())

// Feature: kiro-md-translator-plugin, Property 11: Endpoint URL validation accepts only https:// URLs
describe('endpoint URL validation (Property 11)', () => {
  it('accepts a string iff it starts with https://', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(isValidEndpoint(s)).toBe(/^https:\/\//.test(s))
      }),
      { numRuns: 100 },
    )
    expect(isValidEndpoint('https://x')).toBe(true)
    expect(isValidEndpoint('http://x')).toBe(false)
  })
})

describe('DeepLProvider', () => {
  it('translates a batch and posts to the DeepL endpoint', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ translations: [{ text: 'X' }, { text: 'Y' }] }), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const out = await new DeepLProvider('key').translateBatch(
      ['a', 'b'],
      'en',
      'de',
      new AbortController().signal,
    )
    expect(out).toEqual(['X', 'Y'])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0][0])).toContain('api.deepl.com')
  })

  it('requests the language list as a bodyless GET WITHOUT a Content-Type header', async () => {
    // Regression: DeepL's gateway returns HTTP 400 for a GET that declares
    // Content-Type: application/json but has no body.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ language: 'DE', name: 'German' }]), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const langs = await new DeepLProvider('key').getSupportedLanguages()
    expect(langs).toEqual([{ code: 'de', name: 'German' }])
    const init = fetchMock.mock.calls[0][1] as { headers?: Record<string, string>; body?: unknown }
    const headerKeys = Object.keys(init.headers ?? {}).map((k) => k.toLowerCase())
    expect(headerKeys).not.toContain('content-type')
    expect(init.body).toBeUndefined()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/languages')
  })

  it('normalizes a regional source language (EN-US) to its base code for source_lang', async () => {
    // Regression: DeepL rejects EN-US as source_lang with HTTP 400.
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ translations: [{ text: 'X' }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await new DeepLProvider('key').translateBatch(['x'], 'en-us', 'ru', new AbortController().signal)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      source_lang: string
      target_lang: string
    }
    expect(body.source_lang).toBe('EN')
    expect(body.target_lang).toBe('RU')
  })
})

describe('GoogleTranslateProvider', () => {
  it('chunks requests at 128 segments', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { q: string[] }
      const translations = body.q.map((q) => ({ translatedText: `T(${q})` }))
      return new Response(JSON.stringify({ data: { translations } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const segs = Array.from({ length: 130 }, (_, i) => `s${i}`)
    const out = await new GoogleTranslateProvider('key').translateBatch(
      segs,
      'auto',
      'de',
      new AbortController().signal,
    )
    expect(out).toHaveLength(130)
    expect(out[0]).toBe('T(s0)')
    expect(fetchMock).toHaveBeenCalledTimes(2) // 128 + 2
  })
})

describe('CustomHttpProvider', () => {
  it('rejects a non-https endpoint at construction', () => {
    expect(() => new CustomHttpProvider('k', 'http://insecure')).toThrow()
  })
})

describe('fetchWithTimeout', () => {
  it('maps a timeout to a typed TRANSLATION_TIMEOUT error', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    await expect(
      fetchWithTimeout('https://x', { method: 'GET' }, undefined, 20),
    ).rejects.toMatchObject({ code: 'TRANSLATION_TIMEOUT' })
  })
})
