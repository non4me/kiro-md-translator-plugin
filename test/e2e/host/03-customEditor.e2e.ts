/**
 * E3 — opening a `.md` really lands in this extension's editor.
 *
 * The whole product IS the custom editor: req 1.1 promises that opening a `.md`
 * immediately shows the rendered preview, with no editor and no split view. That
 * depends on three manifest facts plus one runtime fact, and `resolveCustomTextEditor`
 * has no unit coverage whatsoever. A viewType typo, a selector regression, or a
 * `priority` flipped to `option` ships a .vsix where opening a .md gives the plain
 * text editor — and nothing anywhere reports an error.
 *
 * KNOWN LIMITATION, stated rather than faked: if `resolveCustomTextEditor` throws,
 * VS Code swallows it into the webview and the tab still exists. The unhandled-error
 * collector is the only proxy available from the host, so this scenario proves the
 * BINDING, not that the preview rendered. Anything about the rendered DOM needs a
 * webview-driver layer; the extension host cannot reach inside a webview.
 */
import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import {
  type Manifest,
  activatedExtension,
  activeTab,
  assertNoHostErrors,
  closeAllEditors,
  delay,
  waitFor,
  wsUri,
} from './helpers/host'

describe('E3: .md opens in the extension custom editor', () => {
  let ext: vscode.Extension<unknown>
  let m: Manifest
  const uri = () => wsUri('sample.md')

  before(async function () {
    this.timeout(60_000)
    ext = await activatedExtension()
    m = ext.packageJSON as Manifest
    await closeAllEditors()
  })

  afterEach(async () => {
    await closeAllEditors()
  })

  it('claims *.md at the priority req 1.1 needs', () => {
    const editor = m.contributes.customEditors[0]
    assert.deepEqual(
      editor.selector.map((s) => s.filenamePattern),
      ['*.md'],
    )
    // `option` would hand plain `.md` opens back to the text editor, which is
    // precisely what req 1.1 forbids. Absent means default.
    assert.equal(editor.priority ?? 'default', 'default')
  })

  it('is what a plain open of a .md file resolves to', async () => {
    // Not `vscode.openWith`: this is the req 1.1 path — the user just opens the
    // file. It is the one thing `priority: default` actually buys, and the one
    // thing a selector regression breaks.
    await vscode.commands.executeCommand('vscode.open', uri())
    const tab = await waitFor('a tab for the opened document', () => activeTab())

    const input: unknown = tab.input
    if (!(input instanceof vscode.TabInputCustom)) {
      assert.fail(
        `opening sample.md produced a ${(input as object | undefined)?.constructor?.name ?? 'nameless'} ` +
          'tab, not the custom editor — req 1.1 (rendered preview, no split view) is broken',
      )
    }
    assert.equal(input.viewType, m.contributes.customEditors[0].viewType)
    // Always compare Uri.toString(): VS Code lower-cases the drive letter.
    assert.equal(input.uri.toString(), uri().toString())
  })

  it('hands the provider a real TextDocument', async () => {
    await vscode.commands.executeCommand('vscode.openWith', uri(), m.contributes.customEditors[0].viewType)
    await waitFor('the preview tab', () => activeTab())
    // `resolveCustomTextEditor(document, panel)` only runs once VS Code has opened
    // the document model, so this is the proxy for "the provider was actually called".
    await waitFor('sample.md to be an open TextDocument', () =>
      vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri().toString())
        ? true
        : undefined,
    )
  })

  it('resolves without an unhandled host error', async () => {
    await vscode.commands.executeCommand('vscode.openWith', uri(), m.contributes.customEditors[0].viewType)
    await waitFor('the preview tab', () => activeTab())
    await delay(1000)
    assertNoHostErrors('resolveCustomTextEditor')
  })
})
