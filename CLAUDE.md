# Documentation for agents

This file provides guidance for programming agents when working with code in this repository.

## Repository Overview

This is a **FoundryVTT WebRTC plugin** that uses MediaSoup as an SFU (Selective Forwarding Unit) for real-time audio/video communication between players. The plugin enables server-side audio recording for external D&D helper applications while providing a complete A/V solution for tabletop gaming sessions.

## Development Commands

### Build System

The project now has a complete build system with Rollup and npm scripts:

```bash
# Development build with file watching
npm run dev

# Production build
npm run build

# Clean build directory
npm run clean

# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Create distribution package
npm run package

# Run tests with list reporter (prevents browser opening)
npm test -- --reporter=list

# Run tests (opens browser report by default)
npm test
```

## Relevant Documentation

Use the context7 MCP for documentation

- /foundryvtt/foundryvtt
- /versatica/mediasoup
- /versatica/mediasoup-client

## Testing Procedure with Playwright

To ensure the stability and functionality of the Foundry VTT application and its modules, Playwright can be used for automated end-to-end testing.

### Prerequisites

1.  **Node.js and npm:** Ensure you have Node.js and npm installed.
2.  **Playwright:** Install Playwright in your project:
    ```bash
    npm init playwright@latest
    ```
    Follow the prompts to set up your project.

### Starting the Foundry VTT Server for Tests

The `fvtt launch` command can be used to start the Foundry VTT server as a pre-test step. This ensures that the application is running and accessible for Playwright to interact with.

You can integrate this into your Playwright test setup (e.g., in a `globalSetup` file or directly within your test scripts).

### Example Playwright Test Structure

Here's a basic example of how you might structure a Playwright test that includes starting the Foundry VTT server:

```javascript
// playwright.config.js (or a globalSetup file)
// This is a simplified example. For a real setup, consider a dedicated script
// to manage the fvtt launch process and ensure it's fully ready before tests.

const { defineConfig } = require("@playwright/test");
const { execSync } = require("child_process");

module.exports = defineConfig({
  // ... other Playwright configurations

  globalSetup: require.resolve("./global-setup"),
  globalTeardown: require.resolve("./global-teardown"),

  use: {
    baseURL: "http://localhost:30000", // Replace with your Foundry VTT URL
    // ... other use options
  },
});

// global-setup.js
const { execSync } = require("child_process");

async function globalSetup() {
  console.log("Starting Foundry VTT server...");
  // Use 'fvtt launch' to start the server.
  // You might need to adjust the command based on your fvtt-cli setup.
  // Consider adding a delay or a health check to ensure the server is fully up.
  execSync(
    'fvtt launch --adminKey "ABC123" --noupnp --noupdate --world waterdeep --dataPath /Users/lgates/repos/foundryvtt_clone/foundryvtt/data &',
    { stdio: "inherit" },
  );
  console.log("Foundry VTT server started. Waiting for it to be ready...");
  // Add a delay or a more robust health check here
  await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
  console.log("Foundry VTT server should be ready.");
}

module.exports = globalSetup;

// global-teardown.js
const { execSync } = require("child_process");

async function globalTeardown() {
  console.log("Stopping Foundry VTT server...");
  // Command to stop the fvtt server. This might vary based on how it was launched.
  // You might need to find the process ID and kill it.
  execSync('pkill -f "fvtt launch"', { stdio: "inherit" }); // Example: Kills processes containing "fvtt launch"
  console.log("Foundry VTT server stopped.");
}

module.exports = globalTeardown;

// tests/example.spec.js
const { test, expect } = require("@playwright/test");

test("basic Foundry VTT page load", async ({ page }) => {
  await page.goto("/"); // Navigates to baseURL defined in playwright.config.js
  await expect(page.locator("title")).toHaveText(/Foundry Virtual Tabletop/);
  // Add more assertions here to check for UI elements, module loading, etc.
});
```

### Running Tests

To run your Playwright tests:

```bash
npx playwright test
```

This setup provides a robust way to automate testing for your Foundry VTT instance.

---
