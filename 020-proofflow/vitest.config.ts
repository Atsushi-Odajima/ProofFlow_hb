import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@proofflow\/shared$/, replacement: r('./packages/shared/src/index.ts') },
      { find: /^@proofflow\/server\/(.*)$/, replacement: r('./packages/server/src') + '/$1' },
      { find: /^@proofflow\/runner\/(.*)$/, replacement: r('./packages/runner/src') + '/$1' },
      { find: /^@proofflow\/mcp\/(.*)$/, replacement: r('./packages/mcp/src') + '/$1' },
      { find: /^@proofflow\/cli\/(.*)$/, replacement: r('./packages/cli/src') + '/$1' },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
    exclude: ['tests/e2e/**', '**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    env: { NODE_ENV: 'test' },
  },
});
