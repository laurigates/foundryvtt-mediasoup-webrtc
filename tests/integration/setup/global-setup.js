/**
 * Global setup for Playwright tests
 * Handles MediaSoup server startup and test preparation
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

let mediasoupServer = null;

export default async function globalSetup() {
  console.log('[GlobalSetup] Starting test environment setup...');
  
  // Create results directory
  const resultsDir = 'tests/results';
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }
  
  // Build the plugin first
  console.log('[GlobalSetup] Building MediaSoup plugin...');
  try {
    execSync('npm run build', { stdio: 'inherit' });
    console.log('[GlobalSetup] Plugin built successfully');
  } catch (error) {
    console.error('[GlobalSetup] Failed to build plugin:', error);
    throw error;
  }
  
  // Create test fixtures if they don't exist
  createTestFixtures();
  
  // Start MediaSoup server for integration tests
  await startMediaSoupServer();
  
  // Wait for server to be ready
  await waitForServer('ws://localhost:4443', 30000);
  
  console.log('[GlobalSetup] Test environment ready');
}

function createTestFixtures() {
  const fixturesDir = 'tests/integration/fixtures';
  if (!existsSync(fixturesDir)) {
    mkdirSync(fixturesDir, { recursive: true });
  }
  
  // Create a simple test data file
  const testData = {
    users: [
      { id: 'test-user-123', name: 'Test User', isGM: true },
      { id: 'test-user-456', name: 'Test Player', isGM: false }
    ],
    settings: {
      mediaSoupServerUrl: 'ws://localhost:4443',
      autoConnect: true,
      debugLogging: true
    },
    signaling: {
      getRouterRtpCapabilities: {
        codecs: [
          {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2
          },
          {
            kind: 'video',
            mimeType: 'video/VP8',
            clockRate: 90000
          }
        ],
        headerExtensions: [],
        fecMechanisms: []
      }
    }
  };
  
  writeFileSync(
    join(fixturesDir, 'test-data.json'),
    JSON.stringify(testData, null, 2)
  );
  
  console.log('[GlobalSetup] Test fixtures created');
}

async function startMediaSoupServer() {
  console.log('[GlobalSetup] Starting MediaSoup server...');
  
  try {
    // Check if server directory exists
    if (!existsSync('server/Cargo.toml')) {
      console.log('[GlobalSetup] MediaSoup server not found, skipping server startup');
      return;
    }
    
    // Build the server first
    console.log('[GlobalSetup] Building MediaSoup server...');
    execSync('cargo build --release', { 
      cwd: 'server',
      stdio: process.env.DEBUG ? 'inherit' : 'pipe'
    });
    
    // Start the server
    mediasoupServer = spawn('./target/release/mediasoup-server', [], {
      cwd: 'server',
      stdio: process.env.DEBUG ? 'inherit' : 'pipe',
      env: {
        ...process.env,
        RUST_LOG: 'info',
        MEDIASOUP_LISTEN_IP: '127.0.0.1',
        MEDIASOUP_LISTEN_PORT: '4443',
        MEDIASOUP_RTC_MIN_PORT: '10000',
        MEDIASOUP_RTC_MAX_PORT: '10010'
      }
    });
    
    mediasoupServer.on('error', (error) => {
      console.error('[GlobalSetup] MediaSoup server error:', error);
    });
    
    mediasoupServer.on('exit', (code, signal) => {
      console.log(`[GlobalSetup] MediaSoup server exited with code ${code}, signal ${signal}`);
    });
    
    // Store server process for teardown
    global.__MEDIASOUP_SERVER__ = mediasoupServer;
    
    console.log('[GlobalSetup] MediaSoup server started');
    
  } catch (error) {
    console.warn('[GlobalSetup] Failed to start MediaSoup server:', error.message);
    console.warn('[GlobalSetup] Tests will run without server integration');
  }
}

async function waitForServer(url, timeout = 30000) {
  console.log(`[GlobalSetup] Waiting for server at ${url}...`);
  
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    try {
      // Try to connect to the WebSocket server
      const ws = new (await import('ws')).WebSocket(url);
      
      await new Promise((resolve, reject) => {
        const connectTimeout = setTimeout(() => {
          ws.close();
          reject(new Error('Connection timeout'));
        }, 5000);
        
        ws.on('open', () => {
          clearTimeout(connectTimeout);
          ws.close();
          resolve();
        });
        
        ws.on('error', (error) => {
          clearTimeout(connectTimeout);
          reject(error);
        });
      });
      
      console.log('[GlobalSetup] Server is ready');
      return;
      
    } catch (error) {
      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.warn('[GlobalSetup] Server not ready after timeout, continuing without server');
}