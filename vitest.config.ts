import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom gives the UI code real HTMLElements (render hooks receive one
    // in v13+/v14) and gives mediasoup-client's FakeHandler the DOM it needs.
    environment: 'happy-dom',
    // Installs the v14-shaped Foundry globals before any test imports src/:
    // MediaSoupAVClient extends foundry.av.AVClient at module evaluation.
    setupFiles: ['tests/setup.ts'],
    // The Playwright suites run via `bun run test:e2e`, not Vitest.
    include: ['tests/unit/**/*.{test,spec}.ts'],
    // Each file gets fresh globals and a fresh module graph (the entry
    // registers hooks at import time).
    isolate: true,
    restoreMocks: false,
  },
});
