/** Endpoint URL validator (req 4.8 / Property 11): accepts only `https://` URLs. */
export function isValidEndpoint(url: string): boolean {
  return /^https:\/\//.test(url)
}
