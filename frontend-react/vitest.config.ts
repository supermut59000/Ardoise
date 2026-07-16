import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    // fake-indexeddb/auto installs a fake IndexedDB into globalThis so Dexie
    // runs in plain Node without a browser.
    setupFiles: ['./src/test/setup.ts'],
    // .tsx too: component tests (ErrorBoundary) opt into jsdom per file via
    // the @vitest-environment pragma; everything else stays in node.
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
