import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
// End-to-end flows E2E-1 … E2E-10 (real Chromium against the Sample SaaS). Run: pnpm test:e2e
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['tests/e2e/**/*.test.ts'], exclude: ['**/node_modules/**', '**/dist/**'], testTimeout: 600_000, hookTimeout: 600_000, fileParallelism: false },
});
