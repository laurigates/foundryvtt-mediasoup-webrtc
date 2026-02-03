/**
 * MediaSoupVTT - Test entry point for Playwright tests
 * 
 * A test version that doesn't import mediasoup-client and expects it from window.mediasoupClient mock
 */

import { MODULE_ID, MODULE_TITLE, SETTING_AUTO_CONNECT } from './constants/index.js';
import { log } from './utils/logger.js';
import { MediaSoupVTTClient } from './client/MediaSoupVTTClient.js';
import { registerSettings, setupSettingsHooks } from './ui/settings.js';
import { setupSceneControls } from './ui/sceneControls.js';
import { setupPlayerListHooks } from './ui/playerList.js';
import { injectStyles } from './ui/styles.js';
import { MediaSoupConfigDialog } from './ui/configDialog.js';

// In test mode, mediasoup-client should already be provided by mock
// Debug: Log mediasoup-client availability immediately
console.log('MediaSoupVTT (Test): mediasoup-client check:', {
    available: !!window.mediasoupClient,
    version: window.mediasoupClient?.version,
    hasDevice: !!window.mediasoupClient?.Device,
    exports: window.mediasoupClient ? Object.keys(window.mediasoupClient) : []
});

// Global instance of our client
let mediaSoupVTTClientInstance = null;
let isInitialized = false;

// +-------------------------------------------------------------------+
// |                        FOUNDRY VTT HOOKS                          |
// +-------------------------------------------------------------------+

Hooks.once('init', () => {
    if (isInitialized) {
        log('MediaSoupVTT Plugin already initialized, skipping init hook', 'warn');
        return;
    }
    
    log('Initializing MediaSoupVTT Plugin (Test Mode)...', 'info', true);

    // Register all module settings
    registerSettings();

    // Setup settings-related hooks
    setupSettingsHooks();

    // Inject CSS styles
    injectStyles();
});

Hooks.once('ready', async () => {
    if (isInitialized) {
        log('MediaSoupVTT Plugin already ready, skipping ready hook', 'warn');
        return;
    }
    
    log('Foundry VTT is ready. MediaSoupVTT (Test Mode) is active.', 'info', true);
    
    // Add small delay to ensure all mock systems are fully initialized
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // mediasoup-client should be provided by mock in test mode
    if (!window.mediasoupClient) {
        ui.notifications.error(`${MODULE_TITLE}: mediasoup-client library was not found. Mock may not be loaded properly.`, { permanent: true });
        log('mediasoup-client library not found. This should not happen in test mode with mock.', 'error');
        return;
    }
    
    log('mediasoup-client library is available from mock', 'info');
    
    // Register configuration menu now that FormApplication is available
    game.settings.registerMenu(MODULE_ID, 'configDialog', {
        name: 'MediaSoup Server Configuration',
        label: 'Configure MediaSoup Server',
        hint: 'Open the comprehensive configuration dialog with setup instructions.',
        icon: 'fas fa-cogs',
        type: MediaSoupConfigDialog,
        restricted: false
    });

    try {
        // Create global client instance with error handling for test environment
        log('Creating MediaSoupVTTClient instance...', 'debug');
        mediaSoupVTTClientInstance = new MediaSoupVTTClient();
        log('MediaSoupVTTClient instance created successfully', 'debug');
        
        // Expose globally for tests
        window.MediaSoupVTT_Client = mediaSoupVTTClientInstance;
        log('MediaSoupVTT_Client exposed globally', 'debug');
        
        // Update server URL from settings now that they're available
        mediaSoupVTTClientInstance.updateServerUrl();
        log('Client server URL updated from settings', 'debug');
        
        // Mark as initialized to prevent duplicate initialization
        isInitialized = true;
        log('MediaSoupVTT Plugin initialization completed successfully', 'info');
        
    } catch (error) {
        log(`Error creating MediaSoupVTTClient instance: ${error.message}`, 'error');
        console.error('Client instantiation error:', error);
        ui.notifications.error(`${MODULE_TITLE}: Failed to create client instance - ${error.message}`, { permanent: true });
        return;
    }

    // Setup UI hooks
    setupSceneControls();
    setupPlayerListHooks();

    // Handle auto-connection
    const autoConnect = game.settings.get(MODULE_ID, SETTING_AUTO_CONNECT);
    if (autoConnect && mediaSoupVTTClientInstance.serverUrl) {
        log('Auto-connecting to MediaSoup server...');
        try { 
            await mediaSoupVTTClientInstance.connect(); 
        } catch (err) { 
            log(`Auto-connect initial attempt failed: ${err.message}`, 'error'); 
        }
    } else if (autoConnect && !mediaSoupVTTClientInstance.serverUrl) {
        log('Auto-connect enabled, but server URL is not set. Skipping connection.', 'warn');
        ui.notifications.warn(`${MODULE_TITLE}: Auto-connect is on, but server URL is not set.`);
    } else {
        // Try to populate device settings if permissions are already granted
        if (navigator.permissions && navigator.permissions.query) {
            try {
                const micPerm = await navigator.permissions.query({name: 'microphone'});
                const camPerm = await navigator.permissions.query({name: 'camera'});
                if (micPerm.state === 'granted' || camPerm.state === 'granted') {
                    await mediaSoupVTTClientInstance._populateDeviceSettings();
                }
            } catch (e) { 
                log('Error querying permissions on ready: ' + e.message, 'warn'); 
            }
        }
    }
});

log('MediaSoupVTT Plugin (Test Mode) script loaded.');