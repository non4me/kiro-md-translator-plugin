/**
 * E10 — the command handlers survive contact with the real host API.
 *
 * E2 proves the ids are registered. It says nothing about the handlers, and each
 * one reaches into host surfaces the vitest mock does not implement at all:
 * `window.withProgress`, `showInputBox`, `WorkspaceEdit`, `workspace.findFiles`,
 * `ProgressLocation`. A handler that throws on its first line looks exactly like a
 * healthy one in `getCommands()`.
 *
 * DELIBERATELY NOT INVOKED, and why:
 *   * `testConnection` / `testAiAssistantConnection` make outbound calls. This layer
 *     must run with no network and no API key.
 *   * `setApiKey` / `setAiAssistantKey` WITHOUT a keyless provider argument open a
 *     QuickInput whose promise never settles until a human dismisses it — a
 *     guaranteed mocha timeout. Only the keyless short-circuits are exercised here.
 *   * `importComments` against a workspace that really has comments elsewhere opens
 *     a `{ modal: true }` confirmation — same problem. The fixture has no comments in
 *     any store, so the handler takes its "nothing to import" branch.
 * Driving a QuickInput or a modal belongs to a UI-driver layer, not to a smoke layer.
 */
import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import {
  CONFIG_SECTION,
  activatedExtension,
  assertNoHostErrors,
  closeAllEditors,
  delay,
  waitFor,
} from './helpers/host'

const run = (command: string, ...args: unknown[]): Thenable<unknown> =>
  vscode.commands.executeCommand(command, ...args)

describe('E10: the safe commands actually run', () => {
  before(async function () {
    this.timeout(60_000)
    await activatedExtension()
    // No preview open and no text selection anywhere: every command below is then
    // on its guarded/no-op branch, which is the branch this layer can safely drive.
    await closeAllEditors()
  })

  afterEach(() => {
    // A rejecting handler shows up as a rejected executeCommand; a handler that
    // fails inside a void-ed promise shows up only here.
    assertNoHostErrors('a command invocation')
  })

  it('toggleTranslate resolves with no active preview', async () => {
    await run('kiro-md-translator.toggleTranslate')
  })

  it('toggleBilingual resolves with no active preview', async () => {
    await run('kiro-md-translator.toggleBilingual')
  })

  it('saveTranslation resolves with no active preview', async () => {
    await run('kiro-md-translator.saveTranslation')
  })

  it('setApiKey short-circuits for the keyless local provider', async () => {
    // Ollama runs locally and stores nothing, so this returns after a toast instead
    // of opening the blocking input box.
    await run('kiro-md-translator.setApiKey', 'ollama')
  })

  it('setAiAssistantKey short-circuits for the keyless IDE provider', async () => {
    // GitHub Copilot Chat runs inside the IDE and needs no key (req 16.5).
    await run('kiro-md-translator.setAiAssistantKey', 'vscode-copilot')
  })

  it('excludeSelection is a no-op with no selection, and writes nothing', async () => {
    const before = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string[]>('glossary')
    await run('kiro-md-translator.excludeSelection')
    const after = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string[]>('glossary')
    // The empty-selection branch must toast and return. If it ever fell through it
    // would push an empty term into the user's Glossary and invalidate their cache.
    assert.deepEqual(after, before)
    assert.deepEqual(after, [])
  })

  it('importComments walks the project and finds nothing to move', async () => {
    // Drives importDeps(): a real MarkdownRenderer plus workspace.findFiles in the
    // host. The fixture has .md files but no comments in any store, so
    // CommentImporter.plan() returns [] and the handler toasts and returns before
    // any modal.
    await run('kiro-md-translator.importComments')
  })

  it('openSettings reveals the native settings page', async () => {
    await run('kiro-md-translator.openSettings')
    await waitFor('the settings editor to open', () =>
      vscode.window.tabGroups.all.some((g) => g.tabs.length > 0) ? true : undefined,
    )
    await closeAllEditors()
    await delay(100)
  })
})
