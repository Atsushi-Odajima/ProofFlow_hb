import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';
export default mergeConfig(base, defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
}));
