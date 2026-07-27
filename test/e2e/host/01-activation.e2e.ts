/**
 * E1 / E8 / E9 — does the extension wake up at all, and does waking up leak?
 *
 * `src/extension.ts` and `src/ActivationController.ts` have no unit coverage and
 * cannot get any: the vitest `vscode` mock implements neither
 * `window.registerCustomEditorProvider` nor `workspace.fs.createDirectory`, so
 * `activate()` cannot even run there. `activationEvents` is `[]`, which means
 * waking up depends entirely on VS Code inferring `onCustomEditor:` from the
 * manifest. If that inference ever breaks — a viewType rename, an engines bump, a
 * manifest typo — every other test in the repository still passes and the
 * extension is simply dead in the shipped .vsix.
 *
 * This file loads FIRST (see the ordered `files` array in .vscode-test.mjs). Two
 * things depend on that: the error collectors have to be armed before anything
 * touches the extension, and "activation is lazy" is only observable before any
 * other file has woken it.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import * as vscode from 'vscode'
import {
  EXTENSION_ID,
  assertNoHostErrors,
  closeAllEditors,
  delay,
  extension,
  installErrorCollectors,
  openPreview,
  userDataDir,
  wsUri,
} from './helpers/host'

installErrorCollectors()

describe('E1: the extension activates from a cold profile', () => {
  let ext: vscode.Extension<unknown>
  let dormantBeforeFirstUse = false

  before(async function () {
    // A cold profile has to boot the whole workbench before the first assertion.
    this.timeout(120_000)
    ext = extension()
    dormantBeforeFirstUse = !ext.isActive
    await ext.activate()
  })

  it('is registered under the id the manifest promises', () => {
    // The same literal is hardcoded in ActivationController as EXTENSION_ID for the
    // `@ext:` settings filter, and it is the id the marketplace installs under.
    assert.equal(`${ext.packageJSON.publisher}.${ext.packageJSON.name}`, EXTENSION_ID)
  })

  it('stays dormant until something asks for it', () => {
    // With `activationEvents: []` VS Code infers the events from the contributions.
    // An accidental `"*"` (or a stray eager import at host startup) would make every
    // VS Code window pay for this extension whether or not a .md is ever opened.
    assert.equal(
      dormantBeforeFirstUse,
      true,
      'the extension was already active before any test touched it — activation is no longer lazy',
    )
  })

  it('activates without rejecting', () => {
    assert.equal(ext.isActive, true)
  })

  it('exports no API surface', () => {
    // src/extension.ts returns void. Pinning that keeps the rest of this layer
    // honest: no scenario is allowed to quietly grow a back door into host state.
    assert.equal(ext.exports, undefined)
  })
})

describe('E8: activation and a first preview leak no unhandled error', () => {
  before(async function () {
    this.timeout(60_000)
    await extension().activate()
    await openPreview(wsUri('sample.md'))
    // 300 ms render debounce, an async `commentsService.load()`, and the memory
    // monitor's first tick all have to get a chance to run and fail.
    await delay(1500)
    await closeAllEditors()
    // `webviewPanel.onDidDispose` -> `controller.dispose()` -> `commentsService.flush()`.
    await delay(500)
  })

  it('records no unhandledRejection or uncaughtException', () => {
    // The cheapest host-only oracle in the layer, and the ONLY thing that can catch
    // a rejecting `this.ready = this.initApiKey()`: it has no `.catch`, and every
    // consumer of it is `void`-ed, so on a host where SecretStorage rejects (a
    // locked or absent OS keychain) nothing anywhere reports it.
    assertNoHostErrors('activation, first preview open and dispose')
  })
})

describe('E9: the draft comment store survives a cold profile', () => {
  before(async function () {
    this.timeout(60_000)
    await extension().activate()
    // The createDirectory call is `void`-ed, so there is nothing to await.
    await delay(500)
  })

  it('creates the comments directory under globalStorage', async () => {
    // ActivationController fires `void workspace.fs.createDirectory(globalStorageUri
    // + '/comments')` on the claim that createDirectory is recursive and idempotent.
    // The published FileSystem contract documents FileNotFound when the PARENT is
    // missing — and on a cold profile `globalStorage/<id>/` does not exist yet. If
    // the claim is wrong, the call rejects into a void-ed promise and `draft` comment
    // storage (req 11.14) is broken for every first-run user, silently.
    const storageRoot = vscode.Uri.file(path.join(userDataDir(), 'User', 'globalStorage'))
    const entries = await vscode.workspace.fs.readDirectory(storageRoot)
    // VS Code lower-cases the folder name; match case-insensitively rather than
    // guessing which form this host uses.
    const own = entries.find(([name]) => name.toLowerCase() === EXTENSION_ID.toLowerCase())
    if (!own) {
      assert.fail(
        `no globalStorage folder for ${EXTENSION_ID} under ${storageRoot.fsPath} ` +
          `(found: ${entries.map(([n]) => n).join(', ') || 'nothing'})`,
      )
    }
    const comments = vscode.Uri.joinPath(storageRoot, own[0], 'comments')
    const stat = await vscode.workspace.fs.stat(comments)
    assert.equal(stat.type, vscode.FileType.Directory)
  })

  it('did so without an unhandled rejection', () => {
    assertNoHostErrors('the globalStorage bootstrap')
  })
})
