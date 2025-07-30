import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for MediaSoup FoundryVTT Plugin Integration Tests
 * 
 * This configuration enables WebRTC testing with proper browser flags
 * and sets up the testing environment for the plugin.
 */
export default defineConfig({
  testDir: './tests/integration/specs',
  
  /* Run tests sequentially to avoid browser crashes */
  fullyParallel: false,
  
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  
  /* Retry on CI only */
  retries: process.env.CI ? 1 : 0,
  
  /* Use single worker to prevent browser instability */
  workers: 1,
  
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI ? [
    ['list'],
    ['github'],
    ['json', { outputFile: 'tests/results/results.json' }],
    ['junit', { outputFile: 'tests/results/junit.xml' }]
  ] : [
    ['html', { outputFolder: 'tests/results/html-report' }],
    ['json', { outputFile: 'tests/results/results.json' }],
    ['junit', { outputFile: 'tests/results/junit.xml' }]
  ],
  
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.CI ? 'http://localhost:3000?ci=true' : 'http://localhost:3000',
    
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    
    /* Capture screenshot on failure */
    screenshot: 'only-on-failure',
    
    /* Capture video on failure */
    video: 'retain-on-failure',
    
    /* Action timeout - increase for CI environment */
    actionTimeout: process.env.CI ? 90000 : 30000, // 90s in CI, 30s locally
    
    /* Navigation timeout - increase for CI environment */
    navigationTimeout: process.env.CI ? 90000 : 30000, // 90s in CI, 30s locally
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium-webrtc',
      use: { 
        ...devices['Desktop Chrome'],
        // Chrome flags for testing with CI and OS-specific optimizations
        launchOptions: {
          args: [
            // Essential testing flags only
            '--disable-web-security',
            '--allow-file-access-from-files',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--allow-running-insecure-content',
            // Enhanced CI flags for maximum stability
            ...(process.env.CI ? [
              '--no-sandbox',
              '--disable-setuid-sandbox', 
              '--disable-dev-shm-usage',
              '--disable-extensions',
              '--disable-plugins',
              '--no-first-run',
              '--mute-audio',
              '--disable-background-timer-throttling',
              '--disable-backgrounding-occluded-windows',
              '--disable-renderer-backgrounding',
              '--disable-features=TranslateUI',
              '--disable-ipc-flooding-protection',
              '--disable-background-networking',
              '--disable-sync',
              '--disable-default-apps',
              '--disable-component-extensions-with-background-pages',
              '--single-process', // Force single process for CI stability
              // Memory and performance optimizations for CI
              '--memory-pressure-off',
              '--max_old_space_size=4096',
              // OS-specific minimal flags
              ...(process.platform === 'win32' ? [
                '--disable-gpu',
                '--disable-gpu-sandbox',
              ] : []),
              ...(process.platform === 'linux' ? [
                '--disable-gpu',
                '--disable-software-rasterizer',
              ] : []),
            ] : []),
          ],
          // Increased timeout for CI stability
          timeout: process.env.CI ? 120000 : 30000, // 2 minutes in CI for browser launch
          // Slower launch for CI stability
          slowMo: process.env.CI ? 100 : 0,
          // Force headless mode in CI for better stability
          headless: process.env.CI ? true : false,
        },
        
        // Grant permissions for media devices
        permissions: ['camera', 'microphone'],
        
        // Mock geolocation if needed
        geolocation: { latitude: 59.95, longitude: 30.31667 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
      },
    },
    
    {
      name: 'firefox-webrtc',
      use: { 
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.streams.fake': true,
            'media.navigator.permission.disabled': true,
            // Enhanced Firefox settings for CI stability
            ...(process.env.CI ? {
              'dom.webnotifications.enabled': false,
              'browser.shell.checkDefaultBrowser': false,
              'browser.tabs.warnOnClose': false,
              'browser.sessionstore.resume_from_crash': false,
              'browser.crashReports.unsubmittedCheck.enabled': false,
              'dom.disable_beforeunload': true,
              'dom.max_script_run_time': 0,
              'dom.max_chrome_script_run_time': 0,
              'browser.dom.window.dump.enabled': true,
              'devtools.console.stdout.chrome': true,
            } : {}),
          },
          // Enhanced Firefox args for CI stability
          args: process.env.CI ? [
            '--no-remote',
            '--disable-extensions',
            '--no-first-run',
            '--safe-mode',
            '--disable-dev-shm-usage',
          ] : [],
          // Increased timeout for CI stability
          timeout: process.env.CI ? 120000 : 30000,
          // Force headless mode in CI for better stability
          headless: process.env.CI ? true : false,
        },
        // Firefox doesn't support camera/microphone permissions in this context
        // Using firefoxUserPrefs instead to handle media access
      },
    },
  ],

  /* Global setup and teardown */
  globalSetup: './tests/integration/setup/global-setup.js',
  globalTeardown: './tests/integration/setup/global-teardown.js',
  
  /* Test timeout - increase for CI environment */
  timeout: process.env.CI ? 180000 : 60000, // 3 minutes in CI, 1 minute locally
  
  /* Expect timeout - increase for CI environment */
  expect: {
    timeout: process.env.CI ? 45000 : 15000, // 45s in CI, 15s locally
  },
  
  /* Test file patterns */
  testMatch: [
    'tests/integration/specs/**/*.spec.js',
    'tests/integration/specs/**/*.test.js'
  ],
  
  /* Ignore certain files */
  testIgnore: [
    'tests/integration/fixtures/**',
    'tests/integration/setup/**'
  ],
  
  /* Web server configuration for serving test files */
  webServer: {
    command: 'python3 -m http.server 3000',
    port: 3000,
    cwd: '.',
    reuseExistingServer: !process.env.CI,
    timeout: process.env.CI ? 15000 : 10000,
  }
});