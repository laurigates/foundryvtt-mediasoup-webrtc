// Simple test to check MediaSoupVTTClient constructor

import mockMediasoupClient from './tests/integration/mocks/mediasoup-client-mock.js';
import { initializeMockFoundryVTT } from './tests/integration/setup/mock-foundry.js';

console.log('=== Testing MediaSoupVTTClient Constructor ===');

// Setup mock environment
console.log('1. Setting up mock environment...');
const _mockFoundry = initializeMockFoundryVTT();
window.mediasoupClient = mockMediasoupClient;
console.log('Mock environment ready');

// Import and test the client class directly
console.log('2. Importing MediaSoupVTTClient...');
try {
    const { MediaSoupVTTClient } = await import('./src/client/MediaSoupVTTClient.js');
    console.log('MediaSoupVTTClient imported successfully');

    console.log('3. Creating client instance...');
    const client = new MediaSoupVTTClient();
    console.log('Client created:', client);
    console.log('Client constructor name:', client.constructor.name);
    console.log('Client has updateServerUrl method:', typeof client.updateServerUrl === 'function');

    console.log('4. Testing updateServerUrl...');
    client.updateServerUrl();
    console.log('updateServerUrl completed successfully');

    console.log('=== Constructor test PASSED ===');
} catch (error) {
    console.error('=== Constructor test FAILED ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
}
