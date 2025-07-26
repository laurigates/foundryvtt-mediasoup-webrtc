import { test, expect } from '@playwright/test';

/**
 * Settings Configuration Tests
 * 
 * Tests the settings UI, configuration dialog, and settings management
 * functionality of the MediaSoup plugin.
 */

test.describe('MediaSoup Settings Configuration', () => {
  let page;
  
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    
    // Navigate to test sandbox and initialize plugin
    await page.goto('/tests/integration/setup/test-sandbox.html');
    await page.waitForFunction(() => window.testSandbox && window.game);
    
    // Initialize plugin
    await page.click('#btn-init-plugin');
    await page.waitForFunction(() => window.MediaSoupVTT_Client);
  });
  
  test.afterEach(async () => {
    await page.close();
  });
  
  test('should open settings modal from button', async () => {
    // Open settings modal
    await page.click('#btn-open-settings');
    
    // Check that modal is visible
    await expect(page.locator('#settings-modal')).toHaveClass(/visible/);
    await expect(page.locator('#modal-overlay')).toHaveClass(/visible/);
    
    // Check modal content
    await expect(page.locator('.modal-header')).toContainText('MediaSoupVTT Settings');
    await expect(page.locator('#server-url')).toBeVisible();
    await expect(page.locator('#auto-connect')).toBeVisible();
  });
  
  test('should close settings modal on cancel', async () => {
    // Open and close modal
    await page.click('#btn-open-settings');
    await expect(page.locator('#settings-modal')).toHaveClass(/visible/);
    
    await page.click('#btn-cancel-settings');
    await expect(page.locator('#settings-modal')).not.toHaveClass(/visible/);
    await expect(page.locator('#modal-overlay')).not.toHaveClass(/visible/);
  });
  
  test('should close settings modal on overlay click', async () => {
    // Open modal
    await page.click('#btn-open-settings');
    await expect(page.locator('#settings-modal')).toHaveClass(/visible/);
    
    // Click overlay using JavaScript event dispatch to bypass overlay issues
    await page.evaluate(() => {
      document.getElementById('modal-overlay').click();
    });
    await expect(page.locator('#settings-modal')).not.toHaveClass(/visible/);
  });
  
  test('should save settings correctly', async () => {
    // Open settings modal
    await page.click('#btn-open-settings');
    
    // Fill in settings
    const testUrl = 'wss://test-server.com:4443';
    await page.fill('#server-url', testUrl);
    await page.check('#auto-connect');
    
    // Save settings
    await page.click('#btn-save-settings');
    
    // Modal should close
    await expect(page.locator('#settings-modal')).not.toHaveClass(/visible/);
    
    // Check that settings were saved in mock game
    const savedSettings = await page.evaluate(() => ({
      serverUrl: window.game.settings.get('mediasoup-vtt', 'mediaSoupServerUrl'),
      autoConnect: window.game.settings.get('mediasoup-vtt', 'autoConnect')
    }));
    
    expect(savedSettings.serverUrl).toBe(testUrl);
    expect(savedSettings.autoConnect).toBeTruthy();
  });
  
  test('should validate server URL format', async () => {
    // Open settings modal
    await page.click('#btn-open-settings');
    
    // Try invalid URLs
    const invalidUrls = [
      'not-a-url',
      'http://invalid',
      'ftp://invalid.com',
      'invalid://test.com'
    ];
    
    for (const invalidUrl of invalidUrls) {
      await page.fill('#server-url', invalidUrl);
      
      // Should show validation error (browser validation)
      const isValid = await page.evaluate(() => {
        const input = document.getElementById('server-url');
        return input.checkValidity();
      });
      
      expect(isValid).toBeFalsy();
    }
    
    // Try valid URLs
    const validUrls = [
      'ws://localhost:4443',
      'wss://example.com:8080',
      'wss://test-server.local:4443'
    ];
    
    for (const validUrl of validUrls) {
      await page.fill('#server-url', validUrl);
      
      const isValid = await page.evaluate(() => {
        const input = document.getElementById('server-url');
        return input.checkValidity();
      });
      
      expect(isValid).toBeTruthy();
    }
  });
  
  test('should populate device lists when available', async () => {
    // Open settings first to check if any devices are already populated
    await page.click('#btn-open-settings');
    
    // Check what devices are actually available from the browser mock
    const audioOptions = await page.locator('#audio-device option').allTextContents();
    const videoOptions = await page.locator('#video-device option').allTextContents();
    
    // The test should verify that devices are populated (any devices, not specific ones)
    // Browser mock provides: 'Browser Default', 'Fake Default Audio Input', 'Fake Audio Input 1', 'Fake Audio Input 2'
    expect(audioOptions.length).toBeGreaterThan(1); // Should have more than just 'Browser Default'
    expect(audioOptions).toContain('Browser Default'); // Always has this default option
    
    // Check that we have some audio input devices beyond the default
    const audioInputDevices = audioOptions.filter(option => 
      option !== 'Browser Default' && option.includes('Audio')
    );
    expect(audioInputDevices.length).toBeGreaterThan(0);
    
    // For video devices, check that we have at least the default option
    expect(videoOptions).toContain('Browser Default');
  });
  
  test('should update client settings when changed', async () => {
    // Set initial settings
    await page.evaluate(() => {
      window.game.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'ws://initial.com:4443');
    });
    
    // Open settings and change URL
    await page.click('#btn-open-settings');
    const newUrl = 'wss://new-server.com:4443';
    await page.fill('#server-url', newUrl);
    await page.click('#btn-save-settings');
    
    // Check that client instance was updated
    const clientUrl = await page.evaluate(() => window.MediaSoupVTT_Client.serverUrl);
    expect(clientUrl).toBe(newUrl);
  });
  
  test('should show current settings values in modal', async () => {
    // Set some settings first
    await page.evaluate(() => {
      window.game.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'wss://existing.com:4443');
      window.game.settings.set('mediasoup-vtt', 'autoConnect', true);
    });
    
    // Open settings modal
    await page.click('#btn-open-settings');
    
    // Check that current values are shown
    const serverUrl = await page.inputValue('#server-url');
    const autoConnect = await page.isChecked('#auto-connect');
    
    expect(serverUrl).toBe('wss://existing.com:4443');
    expect(autoConnect).toBeTruthy();
  });
  
  test('should handle settings change callbacks', async () => {
    // Track setting changes by hooking into the existing onChange callback
    await page.evaluate(() => {
      window.testSettingChanges = [];
      
      // Get the existing setting and wrap its onChange callback
      const setting = window.game.settings.settings.get('mediasoup-vtt.mediaSoupServerUrl');
      if (setting && setting.onChange) {
        const originalOnChange = setting.onChange;
        setting.onChange = function(value) {
          window.testSettingChanges.push({ 
            module: 'mediasoup-vtt', 
            key: 'mediaSoupServerUrl', 
            value: value 
          });
          return originalOnChange.call(this, value);
        };
      }
    });
    
    // Change a setting to trigger the onChange callback
    await page.evaluate(() => {
      window.game.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'wss://test-change.com:4443');
    });
    
    // Check that onChange was called
    const changes = await page.evaluate(() => window.testSettingChanges);
    expect(changes.some(change => 
      change.module === 'mediasoup-vtt' && 
      change.key === 'mediaSoupServerUrl' &&
      change.value === 'wss://test-change.com:4443'
    )).toBeTruthy();
  });
  
  test('should handle boolean settings correctly', async () => {
    // Test boolean setting (auto-connect)
    await page.click('#btn-open-settings');
    
    // Initially should be unchecked (default false for some settings)
    await page.uncheck('#auto-connect');
    await page.click('#btn-save-settings');
    
    let autoConnect = await page.evaluate(() => 
      window.game.settings.get('mediasoup-vtt', 'autoConnect')
    );
    expect(autoConnect).toBeFalsy();
    
    // Check it and save
    await page.click('#btn-open-settings');
    await page.check('#auto-connect');
    await page.click('#btn-save-settings');
    
    autoConnect = await page.evaluate(() => 
      window.game.settings.get('mediasoup-vtt', 'autoConnect')
    );
    expect(autoConnect).toBeTruthy();
  });
});