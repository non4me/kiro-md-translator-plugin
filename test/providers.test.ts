import { describe, it, expect, vi, afterEach } from 'vitest'
import fc from 'fast-check'
import { isValidEndpoint, isValidOllamaEndpoint } from '../src/providers/urlValidation'
import { DeepLProvider } from '../src/providers/DeepLProvider'
import { GoogleTranslateProvider } from '../src/providers/GoogleTranslateProvider'
import { CustomHttpProvider } from '../src/providers/CustomHttpProvider'
import { OllamaProvider } from '../src/providers/OllamaProvider'
import { createProvider } from '../src/providers/ProviderFactory'
import { fetchWithTimeout } from '../src/providers/http'
import type { PluginConfig } from '../src/types'

afterEach(() => vi.unstubAllGlobals())

function ollamaChatMock(translationsFor: (segs: string[]) => unknown[]) {
  return vi.fn(async (_url: unknown, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> }
    const segs = JSON.parse(parsed.messages[1].content) as string[]
    const content = JSON.stringify({ translations: translationsFor(segs) })
    return new Response(JSON.stringify({ message: { content } }), { status: 200 })
  })
}

const baseConfig: PluginConfig = {
  targetLanguage: 'de',
  storageLanguage: 'en',
  translationMode: 'on-demand',
  providerType: 'ollama',
  customEndpoint: undefined,
  ollamaEndpoint: 'http://localhost:11434',
  ollamaModel: 'llama3.1',
  glossary: [],
}

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

// Feature: kiro-md-translator-plugin, req 4.15
describe('Ollama endpoint validation', () => {
  it('accepts http:// and https:// (local server), rejects others', () => {
    expect(isValidOllamaEndpoint('http://localhost:11434')).toBe(true)
    expect(isValidOllamaEndpoint('https://ollama.internal')).toBe(true)
    expect(isValidOllamaEndpoint('ftp://x')).toBe(false)
    expect(isValidOllamaEndpoint('localhost:11434')).toBe(false)
  })
})

describe('OllamaProvider', () => {
  it('translates a JSON batch preserving order and posts to /api/chat', async () => {
    const fetchMock = ollamaChatMock((segs) => segs.map((s) => `T(${s})`))
    vi.stubGlobal('fetch', fetchMock)
    const out = await new OllamaProvider('http://localhost:11434', 'llama3.1').translateBatch(
      ['a', 'b', 'c'],
      'en',
      'de',
      new AbortController().signal,
    )
    expect(out).toEqual(['T(a)', 'T(b)', 'T(c)'])
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/chat')
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      format: string
      stream: boolean
    }
    expect(body.format).toBe('json')
    expect(body.stream).toBe(false)
  })

  it('falls back to "" for missing entries on a length mismatch (keeps source)', async () => {
    // Model returns fewer translations than segments → the shortfall becomes ''
    const fetchMock = ollamaChatMock(() => ['only-one'])
    vi.stubGlobal('fetch', fetchMock)
    const out = await new OllamaProvider('http://localhost:11434', 'llama3.1').translateBatch(
      ['a', 'b'],
      'en',
      'de',
      new AbortController().signal,
    )
    expect(out).toEqual(['only-one', ''])
  })

  it('chunks at 20 segments per request', async () => {
    const fetchMock = ollamaChatMock((segs) => segs.map((s) => `T(${s})`))
    vi.stubGlobal('fetch', fetchMock)
    const segs = Array.from({ length: 25 }, (_, i) => `s${i}`)
    const out = await new OllamaProvider('http://localhost:11434', 'llama3.1').translateBatch(
      segs,
      'auto',
      'de',
      new AbortController().signal,
    )
    expect(out).toHaveLength(25)
    expect(out[24]).toBe('T(s24)')
    expect(fetchMock).toHaveBeenCalledTimes(2) // 20 + 5
  })

  it('rejects an invalid endpoint at construction', () => {
    expect(() => new OllamaProvider('localhost:11434', 'llama3.1')).toThrow()
  })
})

describe('ProviderFactory (ollama)', () => {
  it('builds a keyless OllamaProvider, ignoring the apiKey', () => {
    const provider = createProvider(baseConfig, '')
    expect(provider.id).toBe('ollama')
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
