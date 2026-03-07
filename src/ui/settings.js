/**
 * Settings registration and management for MediaSoupVTT
 */

import {
    MODULE_ID,
    MODULE_TITLE,
    SETTING_AUTO_CONNECT,
    SETTING_DEBUG_LOGGING,
    SETTING_DEFAULT_AUDIO_DEVICE,
    SETTING_DEFAULT_VIDEO_DEVICE,
    SETTING_MEDIASOUP_URL,
} from '../constants/index.js';
import { log } from '../utils/logger.js';

export function registerSettings() {
    game.settings.register(MODULE_ID, SETTING_DEBUG_LOGGING, {
        name: `${MODULE_TITLE} Debug Logging`,
        hint: 'Outputs verbose logging to the console for debugging purposes.',
        scope: 'client',
        config: true,
        type: Boolean,
        default: false,
    });

    game.settings.register(MODULE_ID, SETTING_MEDIASOUP_URL, {
        name: 'MediaSoup Server WebSocket URL',
        hint: 'The WebSocket URL (e.g., wss://your.server.com:4443). Use the configuration dialog above for detailed setup instructions.',
        scope: 'world',
        config: true,
        type: String,
        default: '',
        onChange: (value) => {
            log(`MediaSoup Server URL changed to: ${value}`);
            const clientInstance = window.MediaSoupVTT_Client;
            if (clientInstance) {
                clientInstance.serverUrl = value;
                if (clientInstance.isConnected || clientInstance.isConnecting) {
                    clientInstance.disconnect();
                    ui.notifications.info(
                        `${MODULE_TITLE}: Server URL changed. Disconnected. Please reconnect manually.`
                    );
                }
            }
        },
    });

    game.settings.register(MODULE_ID, SETTING_AUTO_CONNECT, {
        name: 'Auto-connect to MediaSoup Server',
        hint: 'If checked, attempts to connect automatically when you join a game world.',
        scope: 'client',
        config: true,
        type: Boolean,
        default: true,
    });

    game.settings.register(MODULE_ID, SETTING_DEFAULT_AUDIO_DEVICE, {
        name: 'Default Microphone',
        hint: 'Select preferred microphone. List populates after connecting or opening settings. May need page reload after first permission grant for all labels.',
        scope: 'client',
        config: true,
        type: String,
        default: 'default',
        choices: { default: 'Browser Default' },
    });

    game.settings.register(MODULE_ID, SETTING_DEFAULT_VIDEO_DEVICE, {
        name: 'Default Webcam',
        hint: 'Select preferred webcam. List populates after connecting or opening settings. May need page reload after first permission grant for all labels.',
        scope: 'client',
        config: true,
        type: String,
        default: 'default',
        choices: { default: 'Browser Default' },
    });
}

export function setupSettingsHooks() {
    Hooks.on('renderSettingsConfig', async (app, html, _data) => {
        const clientInstance = window.MediaSoupVTT_Client;
        if (clientInstance && app.constructor.name === 'SettingsConfig') {
            const moduleDetails = html.find(`details[data-module-id="${MODULE_ID}"]`);
            if (moduleDetails.length) {
                // Add helpful styling and status information
                addSettingsEnhancements(moduleDetails, clientInstance);

                if (
                    moduleDetails.attr('open') !== undefined ||
                    !clientInstance.availableAudioDevices
                ) {
                    log(
                        'SettingsConfig rendered for our module, attempting to populate device lists.',
                        'debug'
                    );
                    await clientInstance._populateDeviceSettings();
                    if (app.element?.length) {
                        const currentScroll = app.element.find('.scrollable').scrollTop();
                        app.render(false, { focus: false });
                        app.element.find('.scrollable').scrollTop(currentScroll);
                    }
                }
            }
        }
    });
}

function addSettingsEnhancements(moduleDetails, clientInstance) {
    // Add status indicator to module header
    const summary = moduleDetails.find('summary');
    const isConnected = clientInstance?.isConnected;
    const statusHtml = `
        <span class="mediasoup-status-indicator" style="
            margin-left: 10px;
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: bold;
            ${
                isConnected
                    ? 'background: #d4edda; color: #155724; border: 1px solid #c3e6cb;'
                    : 'background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb;'
            }
        ">
            ${isConnected ? '● Connected' : '● Disconnected'}
        </span>
    `;
    summary.append(statusHtml);

    // Add helpful information after the module settings
    const helpInfo = `
        <div class="mediasoup-settings-help" style="
            margin: 15px 0;
            padding: 15px;
            background: #f8f9fa;
            border: 1px solid #dee2e6;
            border-radius: 5px;
            font-size: 12px;
            line-height: 1.4;
        ">
            <h4 style="margin-top: 0; color: #495057;">
                <i class="fas fa-info-circle"></i> Quick Setup Guide
            </h4>
            <p style="margin: 10px 0;">
                <strong>1.</strong> Set FoundryVTT A/V to "Third Party Module" in Game Settings → Configure Audio/Video<br>
                <strong>2.</strong> Use the "Configure MediaSoup Server" button above for detailed setup<br>
                <strong>3.</strong> Test your connection before starting a session
            </p>
            <p style="margin: 10px 0; padding: 8px; background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 3px;">
                <i class="fas fa-exclamation-triangle"></i> 
                <strong>Important:</strong> FoundryVTT must be configured for "Third Party Module" A/V mode for this plugin to work.
            </p>
        </div>
    `;

    moduleDetails.find('.form-group').last().after(helpInfo);
}
