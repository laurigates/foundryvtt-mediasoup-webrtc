# MediaSoup FoundryVTT Plugin - Integration Testing

> **⚠️ DEFERRED — not currently wired up or run in CI.** This Playwright suite
> predates the Vite migration; it loaded a Rollup-only test bundle
> (`dist/mediasoup-vtt-test.js`) that no longer exists, and it is excluded from
> biome linting. `bun run test:e2e` will **not** pass until the suite is
> re-wired onto the Vite build + a live Foundry harness. The `npm run …`
> commands below are stale (the project now uses **bun**). The CI test gate is
> the Vitest unit suite under `tests/unit/`. Re-wiring is tracked as a
> follow-up issue.

This directory contains a comprehensive integration testing framework for the MediaSoup FoundryVTT plugin. The framework enables testing WebRTC functionality, plugin integration, and server communication without requiring FoundryVTT source code.

## Overview

The testing framework provides:

- **Mock FoundryVTT Environment**: Complete simulation of FoundryVTT's APIs and global objects
- **Browser-based Testing**: Playwright automation with WebRTC support
- **Server Integration**: Docker Compose setup for MediaSoup server testing  
- **CI/CD Pipeline**: GitHub Actions workflow for automated testing

## Architecture

```
tests/
├── integration/
│   ├── setup/
│   │   ├── mock-foundry.js      # Mock FoundryVTT environment
│   │   ├── test-sandbox.html    # Browser test page
│   │   ├── global-setup.js      # Test environment setup
│   │   └── global-teardown.js   # Test cleanup
│   ├── specs/
│   │   ├── plugin-loading.spec.js    # Plugin initialization tests
│   │   ├── settings-config.spec.js   # Settings UI tests
│   │   ├── server-connection.spec.js # WebSocket connection tests
│   │   └── webrtc-media.spec.js      # Media capture tests
│   └── fixtures/
│       └── test-data.json        # Test data and mock responses
├── results/                      # Test output and reports
└── README.md                     # This file
```

## Quick Start

### Prerequisites

- Node.js 18+ with npm
- Docker and Docker Compose (for full integration tests)
- Python 3 (for HTTP server)

### Installation

1. **Install dependencies:**
   ```bash
   npm install
   npm run test:install  # Install Playwright browsers
   ```

2. **Build the plugin:**
   ```bash
   npm run build
   ```

3. **Run tests:**
   ```bash
   # Run all integration tests
   npm run test:integration
   
   # Run with browser UI (for debugging)
   npm run test:headed
   
   # Run in debug mode
   npm run test:debug
   ```

## Test Categories

### 1. Plugin Loading Tests (`plugin-loading.spec.js`)

Tests basic plugin initialization and FoundryVTT integration:

- ✅ Mock environment setup
- ✅ MediaSoup client library loading
- ✅ Plugin initialization lifecycle
- ✅ Settings registration
- ✅ Hook system integration
- ✅ Error handling for missing dependencies

### 2. Settings Configuration Tests (`settings-config.spec.js`)

Tests the settings UI and configuration management:

- ✅ Settings modal display
- ✅ Form validation and input handling
- ✅ Settings persistence
- ✅ Device enumeration
- ✅ Setting change callbacks

### 3. Server Connection Tests (`server-connection.spec.js`)

Tests WebSocket connectivity and signaling protocol:

- ✅ WebSocket connection establishment
- ✅ Connection state management
- ✅ Error handling for invalid URLs
- ✅ Reconnection logic
- ✅ Resource cleanup on disconnect

### 4. WebRTC Media Tests (`webrtc-media.spec.js`)

Tests media capture and WebRTC functionality:

- ✅ Media device enumeration
- ✅ Audio/video stream capture
- ✅ Device constraint handling
- ✅ Media access permission management
- ✅ Stream cleanup and disposal

## Mock Environment

### Mock FoundryVTT Objects

The testing framework provides complete mocks for:

- **`window.game`**: Game state, settings, users
- **`window.ui`**: Notifications, player list, scene controls
- **`window.Hooks`**: Event system for plugin lifecycle
- **`window.$`**: jQuery-compatible DOM manipulation

### Mock APIs

Key FoundryVTT APIs are fully mocked:

```javascript
// Settings API
game.settings.register(module, key, options)
game.settings.get(module, key)
game.settings.set(module, key, value)

// UI Notifications
ui.notifications.info(message)
ui.notifications.warn(message)  
ui.notifications.error(message)

// Hook System
Hooks.on(event, callback)
Hooks.once(event, callback)
Hooks.call(event, ...args)
```

## Browser Configuration

Tests run with WebRTC-optimized browser settings:

### Chrome Flags
- `--use-fake-ui-for-media-stream` - Skip permission prompts
- `--use-fake-device-for-media-stream` - Use fake media devices
- `--auto-accept-camera-and-microphone-capture` - Auto-grant permissions
- `--disable-web-security` - Allow insecure contexts for testing

### Firefox Preferences
- `media.navigator.streams.fake: true` - Enable fake media streams
- `media.navigator.permission.disabled: true` - Skip permission dialogs
- `media.peerconnection.ice.loopback: true` - Enable loopback ICE

## Server Integration

### Docker Compose Setup

Full integration testing with MediaSoup server:

```bash
# Start all services (server + tests)
docker-compose -f docker-compose.test.yml up

# Run only server for local testing
docker-compose -f docker-compose.test.yml up mediasoup-server
```

Services included:

- **mediasoup-server**: Rust MediaSoup server implementation
- **test-server**: HTTP server for serving test files
- **playwright-tests**: Test runner with browser automation

### Local Server Testing

For testing against a local MediaSoup server:

1. **Start the server:**
   ```bash
   cd server
   cargo run --release
   ```

2. **Run tests with server integration:**
   ```bash
   npm run test:integration
   ```

## Debugging

### Visual Debugging

Run tests with browser UI visible:

```bash
npm run test:headed
```

### Debug Mode

Step through tests interactively:

```bash
npm run test:debug
```

### Test Sandbox

Manual testing interface available at:
```
http://localhost:3000/tests/integration/setup/test-sandbox.html
```

Features:
- Plugin initialization controls
- Settings modal testing
- Connection testing
- Media capture testing
- Real-time logging

### Browser DevTools

Access browser DevTools during tests:

```javascript
// Add this to any test for debugging
await page.pause(); // Opens DevTools and pauses execution
```

## CI/CD Integration

### GitHub Actions

Automated testing on:
- ✅ Push to main/develop branches
- ✅ Pull requests
- ✅ Manual workflow dispatch

### Test Matrix

Tests run across:
- **Browsers**: Chromium, Firefox, WebKit
- **Operating Systems**: Ubuntu, macOS, Windows
- **Node.js Versions**: 18, 20

### Artifacts

Test results uploaded as artifacts:
- HTML test reports
- Screenshots on failure
- Video recordings
- Test logs and traces

## Test Data

### Mock Responses (`fixtures/test-data.json`)

Predefined test data including:

- **MediaSoup RTP Capabilities**: Codec definitions for media negotiation
- **Transport Parameters**: ICE/DTLS configuration for WebRTC
- **Mock Devices**: Fake audio/video devices for testing
- **User Data**: Test users and settings

### Custom Test Scenarios

Create custom test scenarios:

```javascript
// Load test data
const testData = await import('./fixtures/test-data.json');

// Use mock signaling responses
await page.evaluate((responses) => {
  window.mockSignalingResponses = responses;
}, testData.signaling.mockResponses);
```

## Performance Testing

### Load Testing

Test multiple concurrent connections:

```javascript
test('should handle multiple users', async ({ browser }) => {
  const contexts = await Promise.all([
    browser.newContext(),
    browser.newContext(), 
    browser.newContext()
  ]);
  
  // Test concurrent plugin instances
});
```

### Memory Leak Detection

Monitor resource cleanup:

```javascript
// Track WebRTC objects
const rtcStats = await page.evaluate(() => ({
  producers: window.MediaSoupVTT_Client.producers.size,
  consumers: window.MediaSoupVTT_Client.consumers.size,
  transports: /* count transports */
}));
```

## Troubleshooting

### Common Issues

1. **MediaSoup server not starting**
   - Check Rust installation: `cargo --version`
   - Verify port availability: `lsof -i :4443`
   - Review server logs in Docker Compose

2. **Browser permission errors**
   - Ensure proper browser flags in playwright.config.js
   - Check that fake media devices are enabled
   - Verify HTTPS context for getUserMedia

3. **Test timeouts**
   - Increase timeout values in test configuration
   - Check network connectivity to test server
   - Review browser console for JavaScript errors

4. **Plugin loading failures**
   - Verify plugin build completed: `ls -la dist/`
   - Check for ES module compatibility issues
   - Review mock environment initialization

### Debug Logs

Enable verbose logging:

```bash
# Debug WebRTC specifically  
WEBRTC_DEBUG=true npm run test:integration

# Debug Playwright
DEBUG=pw:* npm run test:integration

# Debug MediaSoup server
RUST_LOG=debug npm run test:integration
```

### Test Isolation

Ensure tests run independently:

```javascript
test.beforeEach(async ({ page }) => {
  // Clean state before each test
  await page.evaluate(() => {
    // Reset global state
    if (window.MediaSoupVTT_Client) {
      window.MediaSoupVTT_Client.disconnect();
    }
  });
});
```

## Contributing

### Adding New Tests

1. **Create test file** in `tests/integration/specs/`
2. **Follow naming convention**: `feature-name.spec.js`
3. **Include test description** and categorization
4. **Add mock data** to `fixtures/test-data.json` if needed
5. **Update this README** with new test coverage

### Test Structure

```javascript
import { test, expect } from '@playwright/test';

test.describe('Feature Name', () => {
  test.beforeEach(async ({ browser }) => {
    // Setup
  });
  
  test('should do something specific', async () => {
    // Test implementation
  });
  
  test.afterEach(async () => {
    // Cleanup
  });
});
```

### Mock Guidelines

- **Keep mocks minimal** but complete enough for testing
- **Match FoundryVTT APIs** as closely as possible
- **Provide debugging helpers** for test development
- **Document mock limitations** and assumptions

## License

This testing framework is part of the MediaSoup FoundryVTT plugin and follows the same MIT license.