import { defineConfig } from '@vscode/test-cli'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// This file is evaluated in plain Node BEFORE VS Code launches, which is the only
// place a cold profile and a throwaway workspace can be materialised. Both are
// load-bearing, not hygiene:
//
//  * The fixture COPY keeps every write the suite provokes — a `.vscode/settings.json`
//    from a workspace-scoped `update()`, a stray `*.comments.json` sidecar, an import
//    error log — out of the repository. It also keeps the run away from this repo's
//    own `.vscode/settings.json`, which sets `targetLanguage: "ru"`; opening the repo
//    root as the workspace would arm the translation path and turn a suite that must
//    never touch the network into one that does.
//
//  * A fresh `--user-data-dir` per run is what makes the globalStorage scenario mean
//    anything. @vscode/test-electron's default (`.vscode-test/user-data`) survives
//    between runs, so from the second run onwards a "created on a cold profile"
//    assertion would pass without the extension doing anything. The VS Code DOWNLOAD
//    cache is a sibling directory and is still reused, so this costs nothing but the
//    first run.
const scratch = mkdtempSync(join(tmpdir(), 'rmt-e2e-'))
const workspace = join(scratch, 'workspace')
const userData = join(scratch, 'user-data')
cpSync(join(here, 'test', 'e2e', 'host', 'fixtures', 'workspace'), workspace, { recursive: true })

console.log(`[rmt-e2e] workspace  ${workspace}`)
console.log(`[rmt-e2e] user-data  ${userData}`)

// Keep the scratch directory when something failed — it holds the exact profile and
// workspace the failure happened in, which is most of the diagnosis. Drop it on a
// green run so repeated runs do not silt the temp directory up with VS Code profiles.
process.on('exit', (code) => {
  if (code === 0) {
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // Best effort: a lingering Electron file handle is not a test failure.
    }
  } else {
    console.log(`[rmt-e2e] kept ${scratch} for inspection`)
  }
})

const base = {
  // Explicit and ordered, never a bare glob. Mocha loads these in the order given
  // and three scenarios depend on it: the error collectors have to be armed by the
  // first file to load, "activation is lazy" is only observable before any other
  // file has woken the extension, and the no-litter check has to run after
  // everything that could litter.
  files: [
    'out-e2e/01-activation.e2e.js',
    'out-e2e/02-manifest.e2e.js',
    'out-e2e/03-customEditor.e2e.js',
    'out-e2e/04-commands.e2e.js',
    'out-e2e/05-settings.e2e.js',
    'out-e2e/06-pipeline.e2e.js',
    'out-e2e/07-hygiene.e2e.js',
  ],
  // Pushed onto launchArgs by the CLI, so VS Code opens this folder.
  workspaceFolder: workspace,
  launchArgs: [
    `--user-data-dir=${userData}`,
    // Every OTHER extension off. This suite asserts on the full command list and on
    // unhandled errors in the shared extension-host process, and a foreign extension
    // contributes to both. The extension under development is exempt from this flag.
    '--disable-extensions',
    '--disable-telemetry',
    // Headless/VM stability; harmless on a desktop.
    '--disable-gpu',
  ],
  // Reaches the extension host as process.env, which is how the scenarios learn
  // where the throwaway workspace and profile actually are.
  env: {
    RMT_E2E_WORKSPACE: workspace,
    RMT_E2E_USER_DATA: userData,
  },
  mocha: {
    // @vscode/test-cli's runner constructs Mocha with `ui: 'tdd'`. Without this,
    // `describe`/`it` are undefined and every file fails at load with a stack that
    // says nothing about the cause.
    ui: 'bdd',
    // Electron startup, the 300 ms render debounce and the comment flush all happen
    // inside single tests; mocha's 2 s default is far too low.
    timeout: 20000,
    slow: 5000,
  },
  // `extensionDevelopmentPath` is intentionally omitted: it defaults to the
  // directory of this config file (the repo root), which is where `main`
  // (./out/extension.js) lives.
}

// Run the suite against VS Code stable.
//
// To ALSO run it against the floor declared in `engines.vscode` (^1.90.0) — which
// is the only guard that exists against using an API newer than the manifest
// promises, since @types/vscode resolves far above 1.90 — replace the single
// `export default` line below with this pair, then `npx vscode-test --label min-engine`:
//
//   export default defineConfig([
//     { label: 'stable', version: 'stable', ...base },
//     { label: 'min-engine', version: '1.90.0', ...base },
//   ])
//
// It is not the default because it doubles the wall-clock time and needs a second
// VS Code download.
export default defineConfig({ label: 'stable', version: 'stable', ...base })
