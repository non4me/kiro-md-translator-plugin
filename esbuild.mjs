import { build } from 'esbuild'

const common = {
  bundle: true,
  sourcemap: true,
  target: 'es2020',
  logLevel: 'info',
}

// Extension host bundle (Node/CommonJS, `vscode` is provided by the host).
await build({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
})

// Webview bundles (browser sandbox, no Node APIs, no external).
await build({
  ...common,
  entryPoints: ['src/webview/previewPanel.ts'],
  outdir: 'out/webview',
  platform: 'browser',
  format: 'iife',
})

console.log('build complete')
