import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 600_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 95,
        lines: 95,
        functions: 95,
        statements: 95,
      },
    },
  },
});
