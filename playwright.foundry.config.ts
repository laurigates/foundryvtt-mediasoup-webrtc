import { defineConfig, devices } from '@playwright/test';
import { CHROMIUM_ARGS, FOUNDRY_URL } from './tests/e2e/foundry/support/env.js';

/**
 * Playwright: the Foundry e2e tier (tests/e2e/foundry).
 *
 * Runs against a REAL Foundry VTT server (felddy/foundryvtt in CI, or the
 * local foundryvtt-harness) that serves this module from dist/, plus the real
 * Rust SFU that global setup starts on 127.0.0.1. Needs a Foundry license,
 * so CI runs it only when the repository secrets exist
 * (.github/workflows/foundry-e2e.yml). How to run it locally:
 * tests/e2e/foundry/README.md.
 *
 *   bunx playwright test -c playwright.foundry.config.ts
 *
 * PW_CHROMIUM_PATH overrides the browser binary.
 */
export default defineConfig({
  testDir: './tests/e2e/foundry',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/foundry/global-setup.ts',
  outputDir: 'test-results/foundry-e2e/output',

  // One Foundry world and one GM account: Foundry allows one session per
  // user, so the specs run strictly one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  timeout: 240_000,
  // 8 tests x 240 s x (1 + 1 retry) could exceed the CI job's
  // timeout-minutes (75, which also covers the SFU build and the Foundry
  // download). Stop first, so the report and page dumps are still uploaded.
  globalTimeout: 35 * 60_000,
  expect: { timeout: 20_000 },

  reporter: process.env.CI
    ? [
        ['list'],
        ['github'],
        ['html', { open: 'never', outputFolder: 'test-results/foundry-e2e/report' }],
      ]
    : [['list'], ['html', { open: 'never', outputFolder: 'test-results/foundry-e2e/report' }]],

  use: {
    baseURL: FOUNDRY_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: 'chromium-foundry',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['camera', 'microphone'],
        launchOptions: {
          executablePath: process.env.PW_CHROMIUM_PATH || undefined,
          args: CHROMIUM_ARGS,
        },
      },
    },
  ],
});
