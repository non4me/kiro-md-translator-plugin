import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      include: ['src/**'],
    },
  },
  resolve: {
    alias: {
      // The real `vscode` module is only provided by the extension host at
      // runtime. Unit/property tests run in plain Node, so we alias it to a
      // hand-written stub whose methods sinon can spy on / stub.
      vscode: fileURLToPath(new URL('./test/mocks/vscode.ts', import.meta.url)),
    },
  },
})
