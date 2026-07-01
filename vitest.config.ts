import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // The Playwright integration suite under tests/integration/ runs via
    // `bun run test:e2e`, not Vitest — it needs a live Foundry harness.
    include: ['tests/unit/**/*.{test,spec}.ts'],
  },
});
