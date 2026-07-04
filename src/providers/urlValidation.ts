/** Endpoint URL validator (req 4.8 / Property 11): accepts only `https://` URLs. */
export function isValidEndpoint(url: string): boolean {
  return /^https:\/\//.test(url)
}

/**
 * Ollama endpoint validator (req 4.15): accepts `http://` or `https://`, since
 * the Ollama server is local (e.g. `http://localhost:11434`).
 */
export function isValidOllamaEndpoint(url: string): boolean {
  return /^https?:\/\//.test(url)
}
