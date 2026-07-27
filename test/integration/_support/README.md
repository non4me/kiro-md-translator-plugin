# Integration-test support

Integration tests here wire the **real** modules together (`ActivationController`,
`PreviewController`, `TranslationEngine`, `MarkdownRenderer`, `CommentsService`, …) instead of
stubbing the collaborators. Everything they need from the host lives in
[`test/mocks/vscode.ts`](../../mocks/vscode.ts) — there is no second mock layer and no helper
library. Read that file's header comment first; this note is the short version plus the
reasoning you should not have to rediscover.

## Ground rules

- `vitest.config.ts` aliases `vscode` to `test/mocks/vscode.ts`, so a real module doing
  `import * as vscode from 'vscode'` transparently gets the mock. Tests import it explicitly as
  `import * as vscode from '../mocks/vscode'` and hand its objects to SUTs with `as never`
  (the mock diverges from `@types/vscode` on purpose; `tsconfig.json` excludes `test/`).
- Call `vscode.__resetHost()` in `beforeEach`. It clears the filesystem, the document registry,
  workspace folders and window state. Config, secrets and language-model stubs are **not**
  cleared — they have their own seams (`__clearConfig()`, a fresh `MemSecretStorage`,
  `__setLmModels([])`) because a suite usually seeds them once.
- Prefer `controller.renderNow()` / `translateNow()` over waiting on the debounces
  (300 ms render, 1000 ms translate). When you do need time, use `vi.useFakeTimers()` — never a
  real sleep. `controller.start()` arms a 10 s interval, so always `dispose()`.
- Avoid `primeRenderState()`. It is the shortcut the unit tests take; skipping it is precisely
  what lets an integration test catch a `lineMap` bug.

## Seams at a glance

| Area | Seam |
| --- | --- |
| Config | `__setConfig(section, key\|object[, value])`, `__clearConfig()` |
| Host identity | `__setAppName(name)`, `__setLmModels(models)` |
| Filesystem | `__setFile(uri\|path, text\|bytes)`, `__getFile(...)`, `__listFiles()`, `__resetFs()` |
| Events | `__fireConfigChange(section?)`, `__fireDocChange(event)`, `__fireVisibleRanges(event)`, `__fireRenameFiles(files)` |
| Workspace | `__setWorkspaceFolders(folders \| undefined)` |
| Editing | `__addTextDocument(doc)`, `__resetDocuments()`, `__setApplyEditResult(true\|false\|undefined)` |
| Window | `__setActiveTextEditor(editor)`, `__registeredCustomEditors()`, `__progressReports()`, `__cancelProgress()` |
| Wholesale | `__resetHost()` |

Constructible doubles: `MockTextDocument`, `MockWebview`, `MockWebviewPanel`, `MemMemento`,
`MemSecretStorage`, `WorkspaceEdit`, `FileSystemError`, and `__createExtensionContext()` for the
`ExtensionContext` shape `activate()` wants.

## The behaviours that are faithful on purpose

These three are not conveniences; they are traps the production code reasons about. A friendlier
mock would let a wrong fix look right, and one of them had a real data-loss bug behind it.

1. **`workspace.applyEdit` resolves `false` — it never throws.** The document version is captured
   when `edit.replace(...)` records the edit; if the document moved on before `applyEdit`, the
   edit is rejected. Reproduce it by calling `doc.__setText(...)` in between, or force the answer
   with `__setApplyEditResult(false)`. It also resolves `false` when the resource does not exist.
   The comment layer swallows that boolean at its peril: a rejected edit leaves the document
   byte-identical, hence *clean*, which is indistinguishable from "already saved".

2. **`TextDocument.save()` resolves `false` when the document was merely NOT DIRTY.** "Nothing to
   save" and "the save failed" look identical through the return value, which is why
   `ActivationController` writes `(await doc.save()) || !doc.isDirty`. `MockTextDocument.save()`
   returns `false` for a clean document, writes through to `workspace.fs` when it does save, and
   `__failSave()` simulates a genuine failure on a dirty document.

3. **`workspace.fs.readFile` rejects with a `FileSystemError` whose `code` is `'FileNotFound'`.**
   The sidecar and draft comment backends read that rejection as "no comments yet"; a mock that
   resolved `undefined` would make them look correct while hiding a swallowed error. `delete` and
   `stat` reject the same way. Before this existed, the default `fsIO` was a black hole over the
   mock — reads always missed, writes vanished — so comment behaviour *through*
   `ActivationController` was unobservable. It is observable now: assert on `__listFiles()` /
   `__getFile(...)` instead of injecting a `SidecarIO`.

## Divergences worth knowing

- **`Uri.joinPath` does not normalize.** `joinPath(Uri.file('/docs/a.md'), '..')` really is
  `file:///docs/a.md/..`. The filesystem collapses `.`/`..` when it derives its map key, so a
  joined sidecar uri still finds a file seeded by plain path — but a uri *string* is a poor
  assertion target. Compare with `.endsWith('.comments.json')`, and compare uris by
  `.toString()` (uri objects have no equality).
- **`WorkspaceConfiguration.update` ignores its `ConfigurationTarget`**, and `inspect()` reports
  every seeded value as `globalValue`. Consequence: `SettingsManager`'s Workspace-vs-Global branch
  is unobservable, and any `__setConfig` value reads as "explicit" — to simulate "package.json
  default, no explicit value", simply do not seed the key.
- **Documents assume LF.** No CRLF handling, no `EndOfLine` conversion.
- **No DOM.** `vitest.config.ts` pins `environment: 'node'`; a webview-side test would need its
  own `// @vitest-environment jsdom` pragma, and the CSS Custom Highlight API is unavailable
  there either way.
- **No network.** The real providers use global `fetch`, so always inject a fake
  `ITranslationProvider` / `IAssistantProvider` rather than letting `ProviderFactory` build one.
