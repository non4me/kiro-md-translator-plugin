# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Kiro/VS Code extension that opens `.md` files in a rendered, translatable preview. It is built **spec-first**: `.kiro/specs/kiro-md-translator-plugin/{requirements.md,design.md,tasks.md}` is the authoritative source of truth, not the code. Requirements use EARS acceptance criteria with stable numeric ids (e.g. `3.14`, `7.4`); design Properties (`P1`–`P15`) and `tasks.md` both trace back to those ids. When changing behavior, update the spec id chain — code, the `_Requirements:_` footer on the relevant task, and any `Validates:` Property — together.

## Commands

```bash
npm run typecheck      # tsc --noEmit — checks src/ ONLY (test/ is excluded on purpose, see below)
npm test               # vitest run — full suite
npm run build          # esbuild → out/extension.js + out/webview/*.js
npx vitest run test/TranslationCache.test.ts     # single file
npx vitest run -t "Property 9"                    # single test by name

npm run package        # → .vsix via @vscode/vsce (npx, --no-dependencies --allow-missing-repository)
npm run publish:vsce   # publish to VS Marketplace   (needs VSCE_PAT)
npm run publish:ovsx   # publish to Open VSX (Kiro)   (needs OVSX_PAT)
```

There is no linter. Packaging/publishing run `vsce`/`ovsx` on demand via `npx` (not installed as deps). Prefer the `/publish` skill, which drives both markets from one `.vsix`.

## The `vscode` module is mocked — this is the #1 gotcha

The real `vscode` API only exists inside the extension host at runtime. Two separate resolutions:

- **`src/` compiles against real `@types/vscode`** (`tsc`). Production code does `import * as vscode from 'vscode'`.
- **Tests resolve `vscode` to `test/mocks/vscode.ts`** via a vitest `resolve.alias`. The mock is a hand-written stub (EventEmitter, CancellationTokenSource, MemSecretStorage, a config store with `__setConfig`/`__clearConfig`, etc.).

`tsconfig.json` deliberately **excludes `test/`** so tsc never sees the mock's intentional type divergence from `@types/vscode`. Tests therefore import vscode-typed objects from `./mocks/vscode` and pass them to SUTs with `as never` casts. Do not "fix" this by widening `tsconfig` include — vitest (esbuild) is the test oracle, tsc guards production types.

## Architecture (the parts that span files)

**Host ↔ webview split.** The extension host owns all logic and network; the webview is a dumb renderer. They communicate ONLY via two discriminated unions in `src/types.ts`: `WebviewMessage` (webview→host) and `ExtensionMessage` (host→webview). When adding an interaction, add a variant to the union first, then handle it in `PreviewController.onWebviewMessage` and `src/webview/previewPanel.ts`.

**Per-document orchestration.** `ActivationController` registers a `CustomTextEditorProvider` and creates one `PreviewController` per open doc, injecting collaborators via the `PreviewDeps` struct (post fn, renderer, engine, shared cache, settings, exportService, document accessors, `ownedMemoryBytes`). This DI seam is why the controller is unit-testable without a real webview — preserve it; don't reach for `vscode.*` directly inside `PreviewController` logic that needs testing.

**Translation pipeline & the serialization invariant (data integrity).** `TranslationEngine` parses source → walks `text` mdast nodes only (this is how code fences / inline code / link URLs are excluded — they are different node types, never collected) → cache-or-batch through the provider → re-inserts. There are **three distinct output paths, and mixing them corrupts the user's file**:
- **Display**: mdast → hast → sanitized HTML directly (`MarkdownRenderer.renderMdast`). NEVER `remark-stringify` for display.
- **Export** (new file only): `remark-stringify` is acceptable here and ONLY here.
- **In-place paragraph save** (req 7.14): `TranslationEngine.replaceParagraphInSource` does a surgical line-range splice — never re-serialize the whole document back to disk.

**Storage vs Target language.** The on-disk file is always `Storage_Language`; `Target_Language` is an in-memory display transform. Source language for translation is always Storage (never provider auto-detect). Reverse (hover) translation of a *translated* preview is the already-known source — served from `lineMap` with no API call (req 7.3).

**lineMap correspondence.** `MarkdownRenderer` assigns `data-paragraph-index` to `<p>/<h1-6>/<li>` in document order and builds a `lineMap` (paragraphIndex → source line range). Source and translated renders share identical indices, which is what makes element-level scroll sync and surgical write-back work. If you change how blocks are indexed, both must stay in lockstep.

**Cache key.** `TranslationCache` keys on `JSON.stringify([text, lang])`, never `text + '::' + lang` (that collides). `lang` is the *target of that particular translation* — `targetLang` forward, `storageLang` for reverse.

**UI strings (req 8).** All user-facing text goes through `t()` in `src/l10n.ts`, which delegates to `vscode.l10n.t` at runtime and falls back to manual `{0}`/`{1}` substitution when the API is absent (unit tests). Source strings are the reference catalog; per-locale bundles in `l10n/` override them. Don't hard-code display strings — wrap them in `t()`.

## Build specifics

`esbuild.mjs` produces two kinds of bundle: the extension host (`cjs`, `vscode` external, Node platform) and the webview client (`iife`, browser platform, no Node APIs, must stay < 50 KB). The webview entry file (`src/webview/previewPanel.ts`) ends with `export {}` so it is a module — without it its top-level `const`s collide in tsc's global scope. Webview code must never import Node modules or the runtime side of `src/types.ts` (use `import type`). (Settings are the native `contributes.configuration` surface as of v0.2.0 — there is no longer a settings webview bundle.)

## Tests

`*`-marked tasks in `tasks.md` are optional; the mandatory set is listed in that file's Notes. Property tests carry a `// Feature: ..., Property N:` comment and run `numRuns: 100`. Timing-dependent properties (debounce/hover) must use `vi.useFakeTimers()` — never real sleeps.
