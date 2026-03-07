/**
 * Scene controls integration for MediaSoupVTT
 */

import {
    APP_DATA_TAG_MIC,
    APP_DATA_TAG_WEBCAM,
    MODULE_ID,
    MODULE_TITLE,
} from '../constants/index.js';
import { log } from '../utils/logger.js';

export function setupSceneControls() {
    Hooks.on('getSceneControlButtons', (controls) => {
        let avControlsGroup = controls.find((c) => c.name === `${MODULE_ID}-controls`);
        if (!avControlsGroup) {
            avControlsGroup = {
                name: `${MODULE_ID}-controls`,
                title: 'MediaSoup A/V',
                layer: `${MODULE_ID}-layer`,
                icon: 'fas fa-network-wired',
                tools: [],
                activeTool: '',
            };
            controls.push(avControlsGroup);
        } else {
            avControlsGroup.tools = [];
        }

        const commonOnClick = async (action) => {
            const clientInstance = window.MediaSoupVTT_Client;
            if (!clientInstance) {
                ui.notifications.error(`${MODULE_TITLE}: Client not ready.`);
                return;
            }
            if (!clientInstance.isConnected && !['connect', 'disconnect'].includes(action)) {
                ui.notifications.warn(`${MODULE_TITLE}: Not connected to MediaSoup server.`);
                return;
            }
            try {
                switch (action) {
                    case 'connect':
                        if (clientInstance.isConnected || clientInstance.isConnecting) {
                            clientInstance.disconnect();
                        } else if (!clientInstance.serverUrl) {
                            ui.notifications.warn(`${MODULE_TITLE}: Server URL not set.`);
                        } else {
                            await clientInstance.connect();
                        }
                        break;
                    case 'toggleAudio':
                        await clientInstance.toggleAudioMute();
                        break;
                    case 'toggleVideo':
                        await clientInstance.toggleVideoEnabled();
                        break;
                }
            } catch (error) {
                log(`Error in scene control action '${action}': ${error.message}`, 'error');
                ui.notifications.error(`${MODULE_TITLE}: Action failed - ${error.message}`);
            }
        };

        avControlsGroup.tools.push(
            {
                name: `${MODULE_ID}-toggle`,
                title: 'Connect MediaSoup A/V',
                icon: 'fas fa-headset',
                onClick: () => commonOnClick('connect'),
                button: true,
                'data-tool': `${MODULE_ID}-toggle`,
            },
            {
                name: `${MODULE_ID}-media-mic`,
                title: 'Start Microphone',
                icon: 'fas fa-microphone',
                onClick: () => commonOnClick('toggleAudio'),
                button: true,
                visible: false,
                'data-tool': `${MODULE_ID}-media-mic`,
            },
            {
                name: `${MODULE_ID}-media-webcam`,
                title: 'Start Webcam',
                icon: 'fas fa-video',
                onClick: () => commonOnClick('toggleVideo'),
                button: true,
                visible: false,
                'data-tool': `${MODULE_ID}-media-webcam`,
            }
        );

        // Update visibility after adding
        const clientInstance = window.MediaSoupVTT_Client;
        if (clientInstance) {
            clientInstance._updateConnectionStatus(
                clientInstance.isConnected
                    ? 'connected'
                    : clientInstance.isConnecting
                      ? 'connecting'
                      : 'disconnected'
            );
            if (clientInstance.isConnected) {
                clientInstance._updateMediaButtonState(
                    APP_DATA_TAG_MIC,
                    clientInstance.producers.has(APP_DATA_TAG_MIC),
                    clientInstance.producers.get(APP_DATA_TAG_MIC)?.paused
                );
                clientInstance._updateMediaButtonState(
                    APP_DATA_TAG_WEBCAM,
                    clientInstance.producers.has(APP_DATA_TAG_WEBCAM),
                    clientInstance.producers.get(APP_DATA_TAG_WEBCAM)?.paused
                );
            }
        }
    });
}
