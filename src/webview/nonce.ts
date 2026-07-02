import { randomBytes } from 'node:crypto'

/** Random nonce for the CSP `script-src 'nonce-...'` directive. */
export function getNonce(): string {
  return randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '')
}
