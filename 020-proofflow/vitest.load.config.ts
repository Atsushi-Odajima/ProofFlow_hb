import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
// Load / concurrency measurement (not part of `pnpm test`). Run: pnpm test:load — numbers land in docs/load-results-<dialect>.json
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['tests/load/**/*.test.ts'], exclude: ['**/node_modules/**', '**/dist/**'], testTimeout: 1_800_000, hookTimeout: 600_000, fileParallelism: false },
});
