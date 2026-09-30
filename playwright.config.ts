import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright: the SFU e2e tier (tests/e2e/sfu).
 *
 * The real dist/mediasoup-vtt.mjs runs in Chromium on a v14-shaped Foundry
 * stub page and talks to the real Rust SFU (server/target/release). Chromium's
 * fake capture devices supply the audio and video. Build both first:
 * `bun run build` and `cd server && cargo build --release`.
 *
 * PW_CHROMIUM_PATH overrides the browser binary (e.g. a preinstalled
 * Chromium whose revision differs from the one this Playwright pins).
 */
export default defineConfig({
  testDir: './tests/e2e/sfu',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/sfu/global-setup.ts',
  outputDir: 'test-results/e2e',

  // The specs share one SFU and several of them kill or restart servers:
  // run them one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  timeout: 90_000,
  // Stop before the CI job's timeout-minutes (50) so the report is still
  // written and uploaded; a full run takes a few minutes.
  globalTimeout: 20 * 60_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI
    ? [
        ['list'],
        ['github'],
        ['html', { open: 'never', outputFolder: 'test-results/playwright-report' }],
      ]
    : [['list'], ['html', { open: 'never', outputFolder: 'test-results/playwright-report' }]],

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium-sfu',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['camera', 'microphone'],
        launchOptions: {
          executablePath: process.env.PW_CHROMIUM_PATH || undefined,
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--mute-audio',
          ],
        },
      },
    },
  ],
});
