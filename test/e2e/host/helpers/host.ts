/**
 * Shared plumbing for the extension-host e2e layer.
 *
 * Everything here is deliberately thin. This layer exists to catch what only a
 * real VS Code can reveal — activation, manifest/runtime drift, the custom-editor
 * binding, the bundled markdown pipeline under Electron's CommonJS loader, files
 * left behind on disk. A helper that started to encode product behaviour would be
 * in the wrong place; that belongs to the vitest suite.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import * as vscode from 'vscode'

/** The identity the marketplace, the `@ext:` settings filter and the host share. */
export const EXTENSION_ID = 'VladimirTroyanenko.kiro-md-translator-plugin'

/** The settings section every contributed property lives under. */
export const CONFIG_SECTION = 'kiro-md-translator'

/** The namespace every contributed command id lives under. */
export const COMMAND_PREFIX = 'kiro-md-translator.'

// --- manifest shape ---------------------------------------------------------
// Only the parts this layer asserts on. `Extension.packageJSON` is `any`, so
// naming the shape here is what makes a typo in a scenario a compile error.

export interface ManifestCommand {
  command: string
  title?: string
  icon?: { light: string; dark: string } | string
}

export interface ManifestMenuItem {
  command: string
  when?: string
  group?: string
}

export interface ManifestProperty {
  type?: string
  default?: unknown
  order?: number
  enum?: string[]
  enumDescriptions?: string[]
  enumItemLabels?: string[]
}

export interface ManifestConfigSection {
  title: string
  order?: number
  properties: Record<string, ManifestProperty>
}

export interface Manifest {
  name: string
  publisher: string
  version: string
  main: string
  icon?: string
  engines: { vscode: string }
  activationEvents: string[]
  contributes: {
    customEditors: {
      viewType: string
      displayName: string
      selector: { filenamePattern: string }[]
      priority?: string
    }[]
    commands: ManifestCommand[]
    menus: Record<string, ManifestMenuItem[]>
    configuration: ManifestConfigSection[]
  }
}

// --- unhandled errors in the shared host process ----------------------------

export interface HostError {
  kind: 'unhandledRejection' | 'uncaughtException'
  detail: string
}

interface Registry {
  errors: HostError[]
  installed: boolean
}

// Each suite file is compiled as its own esbuild bundle, so each one carries a
// PRIVATE copy of this module. The error log therefore has to live on the
// extension host's global object, or the file that installs the collectors would
// be the only file able to read them back.
const REGISTRY_KEY = Symbol.for('read-markdown-translator.e2e.registry')

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>
  const existing = g[REGISTRY_KEY]
  if (existing) return existing
  const created: Registry = { errors: [], installed: false }
  g[REGISTRY_KEY] = created
  return created
}

function describeError(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`
  try {
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

/**
 * Record every unhandled error raised in the extension-host process.
 *
 * The suite shares that process with the extension, so these listeners observe the
 * extension's OWN failures. That is the only way to see the `void`-ed promises on
 * the activation path: `this.ready = this.initApiKey()` is stored with no `.catch`
 * and every consumer of it is `void`-ed, so a rejecting SecretStorage or a
 * rejecting `createDirectory` produces no visible symptom at all.
 *
 * `uncaughtExceptionMonitor` rather than `uncaughtException`, so the process keeps
 * its normal crash semantics and this stays a pure observer.
 *
 * Called at module scope of the first suite file, i.e. before any test runs and
 * before anything has woken the extension. Errors raised between host startup and
 * that moment are outside the window — but nothing of ours runs there either.
 */
export function installErrorCollectors(): void {
  const r = registry()
  if (r.installed) return
  r.installed = true
  process.on('unhandledRejection', (reason) => {
    r.errors.push({ kind: 'unhandledRejection', detail: describeError(reason) })
  })
  process.on('uncaughtExceptionMonitor', (err) => {
    r.errors.push({ kind: 'uncaughtException', detail: describeError(err) })
  })
}

export function hostErrors(): HostError[] {
  return [...registry().errors]
}

/** Fail with the captured reasons verbatim — a swallowed rejection is useless as a
 *  signal unless the failure message says what it actually was. */
export function assertNoHostErrors(during: string): void {
  assert.deepEqual(
    hostErrors().map((e) => `${e.kind}: ${e.detail}`),
    [],
    `unhandled error(s) in the extension host during ${during}`,
  )
}

// --- the extension ----------------------------------------------------------

export function extension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID)
  if (!ext) {
    assert.fail(
      `no extension registered under "${EXTENSION_ID}" — publisher/name drift in package.json, ` +
        'or the manifest failed to parse',
    )
  }
  return ext
}

export async function activatedExtension(): Promise<vscode.Extension<unknown>> {
  const ext = extension()
  await ext.activate()
  return ext
}

export function manifest(): Manifest {
  return extension().packageJSON as Manifest
}

export function viewType(): string {
  return manifest().contributes.customEditors[0].viewType
}

// --- the throwaway workspace and profile ------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    assert.fail(`${name} is unset — .vscode-test.mjs must export it into the host env`)
  }
  return value
}

export function workspaceDir(): string {
  return requiredEnv('RMT_E2E_WORKSPACE')
}

export function userDataDir(): string {
  return requiredEnv('RMT_E2E_USER_DATA')
}

/**
 * A Uri inside the throwaway workspace.
 *
 * Always compare `Uri.toString()` values, never `fsPath` against a Node path: VS
 * Code lower-cases the drive letter inside URIs and @vscode/test-cli lower-cases it
 * again for the loader, so on `D:\` a raw `===` on `fsPath` is a coin flip.
 */
export function wsUri(...segments: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(workspaceDir(), ...segments))
}

// --- waiting ----------------------------------------------------------------

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `probe` returns something other than undefined, or fail loudly. */
export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) {
      assert.fail(`timed out after ${timeoutMs} ms waiting for ${what}`)
    }
    await delay(50)
  }
}

// --- editors ----------------------------------------------------------------

export function activeTab(): vscode.Tab | undefined {
  return vscode.window.tabGroups.activeTabGroup.activeTab ?? undefined
}

export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await waitFor('every editor tab to close', () =>
    vscode.window.tabGroups.all.every((g) => g.tabs.length === 0) ? true : undefined,
  )
}

/** Open a document in the extension's own custom editor and wait for its tab. */
export async function openPreview(uri: vscode.Uri): Promise<vscode.Tab> {
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType())
  return waitFor('the preview tab to appear', () => activeTab())
}

// --- filesystem -------------------------------------------------------------

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri)
    return true
  } catch {
    return false
  }
}

export async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
}

/** Recursive `relative path [+ size]` listing, used to prove nothing was written. */
export async function snapshotTree(root: vscode.Uri): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: vscode.Uri, prefix: string): Promise<void> => {
    const entries = [...(await vscode.workspace.fs.readDirectory(dir))].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )
    for (const [name, type] of entries) {
      const rel = prefix ? `${prefix}/${name}` : name
      const child = vscode.Uri.joinPath(dir, name)
      if (type === vscode.FileType.Directory) {
        out.push(`${rel}/`)
        await walk(child, rel)
      } else {
        out.push(`${rel} ${(await vscode.workspace.fs.stat(child)).size}`)
      }
    }
  }
  await walk(root, '')
  return out
}

// --- NLS --------------------------------------------------------------------

/**
 * Every string in the manifest that is EXACTLY a `%key%` placeholder.
 *
 * Walking the parsed JSON, not regexing the raw text: several
 * `markdownDescription`s carry URL-encoded command links
 * (`command:...?%5B%22deepl%22%5D`), and a substring match over those invents two
 * dozen placeholder keys that do not exist.
 */
export function nlsPlaceholders(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const m = /^%([\w.\-]+)%$/.exec(value)
    if (m) found.add(m[1])
  } else if (Array.isArray(value)) {
    for (const item of value) nlsPlaceholders(item, found)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) nlsPlaceholders(item, found)
  }
  return found
}

/**
 * Resolve a manifest string that may still be a `%key%` placeholder.
 *
 * Whether `Extension.packageJSON` hands back the raw manifest or the NLS-resolved
 * one is a host implementation detail. The promise under test is the same either
 * way: what reaches the Settings page must be a real title, never a literal `%…%`.
 * Returns undefined when the placeholder has no bundle entry — which is exactly
 * the failure that ships a Settings section titled `%config.section.provider%`.
 */
export function resolveNls(value: string, bundle: Record<string, string>): string | undefined {
  const m = /^%([\w.\-]+)%$/.exec(value)
  return m ? bundle[m[1]] : value
}
