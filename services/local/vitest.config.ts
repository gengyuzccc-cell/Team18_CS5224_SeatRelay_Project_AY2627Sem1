import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The integration tests share one PostgreSQL schema.
    fileParallelism: false,
  },
});
