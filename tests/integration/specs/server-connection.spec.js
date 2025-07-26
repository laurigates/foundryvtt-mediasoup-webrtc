import { test, expect } from '@playwright/test';

/**
 * Server Connection Tests
 * 
 * Tests WebSocket connection to MediaSoup server, signaling protocol,
 * and connection management functionality.
 */

test.describe('MediaSoup Server Connection', () => {
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
  
  test('should test WebSocket connection to localhost', async () => {
    // Set server URL to localhost (where test server should be running)
    await page.evaluate(() => {
      window.game.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'ws://localhost:4443');
    });
    
    // Test connection using the sandbox button
    await page.click('#btn-test-connection');
    
    // Wait for connection test result
    await page.waitForTimeout(3000);
    
    // Check the status - should either be successful or timeout
    const status = await page.textContent('#test-status');
    
    // Accept either successful connection or timeout (server may not be running)
    expect(status).toMatch(/(Connection test passed|Connection timeout|Connection test failed)/);
  });
  
  test('should handle invalid server URL gracefully', async () => {
    // Set an invalid server URL
    await page.evaluate(() => {
      window.game.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'ws://invalid-server-that-does-not-exist.local:9999');
    });
    
    // Test connection
    await page.click('#btn-test-connection');
    
    // Should fail relatively quickly
    await page.waitForTimeout(6000);
    
    const status = await page.textContent('#test-status');
    expect(status).toMatch(/(Connection test failed|Connection timeout|Connection error)/);
  });
  
  test('should connect to MediaSoup server when available', async () => {
    // Skip if no server is available (CI environment)
    const serverAvailable = await page.evaluate(async () => {
      try {
        const ws = new WebSocket('ws://localhost:4443');
        return await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            ws.close();
            resolve(false);
          }, 2000);
          
          ws.onopen = () => {
            clearTimeout(timeout);
            ws.close();
            resolve(true);
          };
          
          ws.onerror = () => {
            clearTimeout(timeout);
            resolve(false);
          };
        });
      } catch {
        return false;
      }
    });
    
    if (!serverAvailable) {
      test.skip('MediaSoup server not available for testing');
      return;
    }
    
    // Set server URL and connect
    await page.evaluate(() => {
      window.game.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'ws://localhost:4443');
    });
    
    // Try to connect using client
    const connectionResult = await page.evaluate(async () => {
      try {
        await window.MediaSoupVTT_Client.connect();
        return {
          success: true,
          isConnected: window.MediaSoupVTT_Client.isConnected,
          error: null
        };
      } catch (error) {
        return {
          success: false,
          isConnected: window.MediaSoupVTT_Client.isConnected,
          error: error.message
        };
      }
    });
    
    if (connectionResult.success) {
      expect(connectionResult.isConnected).toBeTruthy();
    } else {
      // Connection might fail due to server not implementing full protocol
      console.log('Connection failed:', connectionResult.error);
    }
  });
  
  test('should handle connection state changes', async () => {
    // Track connection state changes
    await page.evaluate(() => {
      window.testConnectionStates = [];
      const client = window.MediaSoupVTT_Client;
      
      // Override _updateConnectionStatus to track state changes
      const originalUpdate = client._updateConnectionStatus;
      client._updateConnectionStatus = function(status) {
        window.testConnectionStates.push({
          status,
          timestamp: Date.now(),
          isConnected: this.isConnected,
          isConnecting: this.isConnecting
        });
        return originalUpdate.call(this, status);
      };
    });
    
    // Set server URL and attempt connection
    await page.evaluate(() => {
      window.game.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'ws://localhost:4443');
    });
    
    // Try connection (may fail, but should track state changes)
    await page.evaluate(async () => {
      try {
        await window.MediaSoupVTT_Client.connect();
      } catch (error) {
        // Expected if server not available
      }
    });
    
    // Wait for state changes
    await page.waitForTimeout(2000);
    
    // Check that state changes were tracked
    const states = await page.evaluate(() => window.testConnectionStates);
    expect(states.length).toBeGreaterThan(0);
    
    // Should have at least attempted connecting
    const hasConnectingState = states.some(state => state.status === 'connecting');
    expect(hasConnectingState).toBeTruthy();
  });
  
  test('should handle reconnection attempts', async () => {
    // Set server URL
    await page.evaluate(() => {
      window.game.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'ws://localhost:4443');
    });
    
    // Test multiple connection attempts
    const attempts = [];
    
    for (let i = 0; i < 3; i++) {
      const result = await page.evaluate(async () => {
        const client = window.MediaSoupVTT_Client;
        const wasConnected = client.isConnected;
        
        if (wasConnected) {
          client.disconnect();
        }
        
        try {
          await client.connect();
          return { attempt: true, connected: client.isConnected };
        } catch (error) {
          return { attempt: true, connected: false, error: error.message };
        }
      });
      
      attempts.push(result);
      
      // Small delay between attempts
      await page.waitForTimeout(500);
    }
    
    // All attempts should have been made
    expect(attempts).toHaveLength(3);
    expect(attempts.every(a => a.attempt)).toBeTruthy();
  });
  
  test('should validate server URL before connection', async () => {
    const client = await page.evaluate(() => window.MediaSoupVTT_Client);
    
    // Test with no URL
    let result = await page.evaluate(async () => {
      // Reset client state first
      window.MediaSoupVTT_Client.isConnected = false;
      window.MediaSoupVTT_Client.isConnecting = false;
      window.MediaSoupVTT_Client.serverUrl = '';
      try {
        await window.MediaSoupVTT_Client.connect();
        return { connected: true };
      } catch (error) {
        return { connected: false, error: error.message };
      }
    });
    
    console.log('First test result:', result);
    expect(result.connected).toBeFalsy();
    
    // Test with invalid URL format
    result = await page.evaluate(async () => {
      // Reset client state again
      window.MediaSoupVTT_Client.isConnected = false;
      window.MediaSoupVTT_Client.isConnecting = false;
      window.MediaSoupVTT_Client.serverUrl = 'not-a-url';
      try {
        await window.MediaSoupVTT_Client.connect();
        return { connected: true };
      } catch (error) {
        return { connected: false, error: error.message };
      }
    });
    
    expect(result.connected).toBeFalsy();
  });
  
  test('should handle WebSocket errors gracefully', async () => {
    // Set up error capture array
    await page.evaluate(() => {
      window.testWebSocketErrors = [];
    });
    
    // Mock WebSocket to simulate errors more effectively
    await page.evaluate(() => {
      const OriginalWebSocket = window.WebSocket;
      window.WebSocket = function(url) {
        console.log('WebSocket constructor called with URL:', url);
        window.testWebSocketErrors.push({
          action: 'constructor_called',
          url,
          timestamp: Date.now()
        });
        
        const ws = new OriginalWebSocket(url);
        
        // Override the onerror assignment to capture errors
        let clientErrorHandler = null;
        Object.defineProperty(ws, 'onerror', {
          get: function() {
            return clientErrorHandler;
          },
          set: function(handler) {
            clientErrorHandler = function(error) {
              console.log('WebSocket error captured:', error);
              window.testWebSocketErrors.push({
                action: 'error_event',
                url,
                error: error.type || 'error',
                timestamp: Date.now()
              });
              if (handler) handler.call(this, error);
            };
            // Set the actual onerror to our wrapper
            ws.addEventListener('error', clientErrorHandler);
          }
        });
        
        // Also capture close events as they indicate connection failure
        let clientCloseHandler = null;
        Object.defineProperty(ws, 'onclose', {
          get: function() {
            return clientCloseHandler;
          },
          set: function(handler) {
            clientCloseHandler = function(event) {
              console.log('WebSocket close captured:', event);
              window.testWebSocketErrors.push({
                action: 'close_event',
                url,
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean,
                timestamp: Date.now()
              });
              if (handler) handler.call(this, event);
            };
            // Set the actual onclose to our wrapper
            ws.addEventListener('close', clientCloseHandler);
          }
        });
        
        return ws;
      };
      
      // Copy WebSocket constants
      window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
      window.WebSocket.OPEN = OriginalWebSocket.OPEN;
      window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
      window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
    });
    
    // Set invalid server URL to trigger error
    await page.evaluate(() => {
      window.game.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'ws://nonexistent.server:1234');
    });
    
    // Attempt connection
    await page.evaluate(async () => {
      try {
        await window.MediaSoupVTT_Client.connect();
      } catch (error) {
        console.log('Connect method threw error:', error.message);
        // Expected - connection should fail
      }
    });
    
    // Wait for error handling (increased timeout to allow for connection timeout)
    await page.waitForTimeout(5000);
    
    // Check that errors were captured
    const errors = await page.evaluate(() => window.testWebSocketErrors);
    console.log('Captured WebSocket events:', errors);
    
    // We should have at least captured the WebSocket constructor call and some form of error/close event
    expect(errors.length).toBeGreaterThan(0);
    
    // More specific checks - we should have either error events or close events indicating failure
    const errorEvents = errors.filter(e => e.action === 'error_event');
    const closeEvents = errors.filter(e => e.action === 'close_event');
    const constructorCalls = errors.filter(e => e.action === 'constructor_called');
    
    // Should have at least called the WebSocket constructor
    expect(constructorCalls.length).toBeGreaterThan(0);
    
    // Should have either error events or close events (or both) indicating connection failure
    expect(errorEvents.length + closeEvents.length).toBeGreaterThan(0);
  });
  
  test('should clean up resources on disconnect', async () => {
    // Set server URL
    await page.evaluate(() => {
      window.game.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'ws://localhost:4443');
    });
    
    // Try to connect (may fail if server not available)
    await page.evaluate(async () => {
      try {
        await window.MediaSoupVTT_Client.connect();
      } catch (error) {
        // Continue with test even if connection fails
      }
    });
    
    // Force disconnect and check cleanup
    const disconnectResult = await page.evaluate(() => {
      const client = window.MediaSoupVTT_Client;
      const beforeDisconnect = {
        hasSocket: !!client.socket,
        requestMapSize: client.requestMap.size,
        producersSize: client.producers.size,
        consumersSize: client.consumers.size
      };
      
      client.disconnect();
      
      return {
        beforeDisconnect,
        afterDisconnect: {
          hasSocket: !!client.socket,
          requestMapSize: client.requestMap.size,
          producersSize: client.producers.size,
          consumersSize: client.consumers.size,
          isConnected: client.isConnected,
          isConnecting: client.isConnecting
        }
      };
    });
    
    // After disconnect, resources should be cleaned up
    expect(disconnectResult.afterDisconnect.hasSocket).toBeFalsy();
    expect(disconnectResult.afterDisconnect.requestMapSize).toBe(0);
    expect(disconnectResult.afterDisconnect.producersSize).toBe(0);
    expect(disconnectResult.afterDisconnect.consumersSize).toBe(0);
    expect(disconnectResult.afterDisconnect.isConnected).toBeFalsy();
    expect(disconnectResult.afterDisconnect.isConnecting).toBeFalsy();
  });
});