import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.{ts,tsx}',
      'tests/unit/**/*.test.ts',
    ],
    environment: 'node',
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**', 'apps/*/scripts/**'],
    },
  },
});
