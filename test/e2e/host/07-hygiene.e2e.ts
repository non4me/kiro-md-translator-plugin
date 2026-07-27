/**
 * E13 — opening and closing a preview leaves no files behind.
 *
 * This is a shipped regression, not a hypothetical: 0.4.1 fixed "Opening and
 * closing a preview no longer creates an empty `.<name>.comments.json` sidecar next
 * to the file". The write path only runs in a real host — `resolveCustomTextEditor`
 * builds a CommentsService over the SidecarBackend, `controller.start()` calls
 * `load()`, and `dispose()` calls `flush()` — and comment auto-import is on by
 * default, which is what can provoke the dispose path into writing.
 *
 * Runs LAST (see the ordered `files` array in .vscode-test.mjs) so that anything an
 * earlier scenario left behind is attributed to the right place: the before/after
 * snapshot is taken around THIS scenario's open/close, and the explicit checks below
 * catch litter from anywhere in the run.
 */
import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import {
  activatedExtension,
  closeAllEditors,
  delay,
  exists,
  openPreview,
  readText,
  snapshotTree,
  workspaceDir,
  wsUri,
} from './helpers/host'

describe('E13: a preview open/close writes nothing to the workspace', () => {
  const root = () => vscode.Uri.file(workspaceDir())
  let treeBefore: string[]
  let sourceBefore: string

  before(async function () {
    this.timeout(60_000)
    await activatedExtension()
    await closeAllEditors()

    treeBefore = await snapshotTree(root())
    sourceBefore = await readText(wsUri('sample.md'))

    await openPreview(wsUri('sample.md'))
    // 300 ms render debounce plus the asynchronous comment load.
    await delay(1500)
    await closeAllEditors()
    // onDidDispose -> controller.dispose() -> commentsService.flush().
    await delay(500)
  })

  it('leaves the workspace tree byte-for-byte identical', async () => {
    assert.deepEqual(await snapshotTree(root()), treeBefore)
  })

  it('creates no comment sidecar next to the document', async () => {
    // src/commentSidecar.ts: docs/api.md -> docs/api.md.comments.json.
    assert.equal(await exists(wsUri('sample.md.comments.json')), false)
    assert.equal(await exists(wsUri('docs', 'nested.md.comments.json')), false)
  })

  it('creates no comment-import error log', async () => {
    // ActivationController writes this into the workspace root, but ONLY on failure —
    // a feature whose point is "no litter in the repo" must not drop a file after a
    // successful run either.
    assert.equal(await exists(wsUri('rmt-comment-import-errors.log')), false)
  })

  it('never touches the Markdown document itself', async () => {
    // The inline comment backend rewrites the .md; the sidecar backend (the default)
    // must never do so. This is the data-integrity end of req 11.
    assert.equal(await readText(wsUri('sample.md')), sourceBefore)
  })
})
