import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'packages/llm-providers/*/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'acceptance',
          include: ['test/acceptance/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
