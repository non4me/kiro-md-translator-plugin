import { build } from 'esbuild'
import { readdirSync } from 'node:fs'

// The extension-host e2e suite. Compiled with the SAME options as the production
// host bundle in esbuild.mjs, on purpose: the scenarios that import from `src/`
// (SettingsManager, MarkdownRenderer, getNonce) are then executing the same
// ESM -> CommonJS flattening the shipped extension executes, under the same
// Electron Node runtime. Vitest runs those modules as real ESM through Vite,
// which is a different module system and cannot answer that question.
const dir = 'test/e2e/host'

// esbuild does not expand globs, and neither does PowerShell — enumerate instead.
const entryPoints = readdirSync(dir)
  .filter((f) => f.endsWith('.e2e.ts'))
  .map((f) => `${dir}/${f}`)

if (entryPoints.length === 0) {
  throw new Error(`no *.e2e.ts entry points under ${dir}/ — nothing to compile`)
}

await build({
  entryPoints,
  // NOT `out/`: .vscodeignore does not exclude out/** (that is the shipped
  // runtime), so e2e bundles placed there would be packaged into the .vsix.
  outdir: 'out-e2e',
  outbase: dir,
  bundle: true,
  platform: 'node',
  // @vscode/test-cli's runner does `mocha.addFile` + `require`, and package.json
  // has no `"type": "module"`, so the output has to be CommonJS.
  format: 'cjs',
  // Mandatory: the extension host injects `vscode` into the module loader at
  // require time. Bundling it away would break every scenario.
  external: ['vscode'],
  target: 'node18',
  sourcemap: true,
  sourcesContent: true,
  logLevel: 'info',
})

console.log(`e2e build complete (${entryPoints.length} suite files)`)
