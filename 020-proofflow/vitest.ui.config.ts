import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
// Web UI verification on PC / iPhone / Android viewports (real Chromium, built SPA served by the control plane). Run: pnpm build:web && pnpm test:ui
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['tests/ui/**/*.test.ts'], exclude: ['**/node_modules/**', '**/dist/**'], testTimeout: 600_000, hookTimeout: 600_000, fileParallelism: false },
});
