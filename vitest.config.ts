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
    // `bun run test:coverage` (CI runs it). Thresholds sit a little below the
    // measured numbers so coverage can only ratchet up; raise them as tests land.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Ambient types only: no runtime code to cover.
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // Measured 2026-10 (statements / branches / functions / lines): all
      // 83.9 / 72.9 / 87.0 / 87.9; MediaSoupAVClient 85.9 / 75.3 / 87.3 / 89.1;
      // src/ui 94.6 / 76.3 / 94.7 / 95.1. src/client as a whole sits at the
      // global level, so it gets no separate glob; the AVClient and the UI do.
      thresholds: {
        statements: 82,
        branches: 71,
        functions: 85,
        lines: 86,
        'src/client/MediaSoupAVClient.ts': {
          statements: 83,
          branches: 73,
          functions: 85,
          lines: 87,
        },
        'src/ui/**': {
          statements: 92,
          branches: 74,
          functions: 92,
          lines: 93,
        },
      },
    },
  },
});
