/**
 * Player list integration for MediaSoupVTT
 */

import { log } from '../utils/logger.js';

export function setupPlayerListHooks() {
    /**
     * Hook into rendering the player list to add video elements.
     */
    Hooks.on('renderPlayerList', (_playerListApp, html, _data) => {
        const clientInstance = window.MediaSoupVTT_Client;
        if (!clientInstance || !clientInstance.isConnected) {
            // Clean up any existing video elements if not connected
            const existingContainers = html[0].querySelectorAll('.mediasoup-video-container');
            existingContainers.forEach((container) => container.remove());
            return;
        }

        log('Rendering player list. Updating A/V elements.', 'debug');

        // Support both v12 and v13 player list structures
        const playerElements = html[0].querySelectorAll('li.player, .player');
        playerElements.forEach((playerElement) => {
            // Try multiple ways to get userId for v13 compatibility
            let userId =
                playerElement.dataset.userId ||
                playerElement.dataset['user-id'] ||
                playerElement.getAttribute('data-user-id');

            // Fallback: look for user ID in nested elements or attributes
            if (!userId) {
                const userElement = playerElement.querySelector('[data-user-id]');
                if (userElement) {
                    userId =
                        userElement.dataset.userId ||
                        userElement.dataset['user-id'] ||
                        userElement.getAttribute('data-user-id');
                }
            }

            if (!userId) return;

            // Remove old container first to ensure clean update
            const existingContainer = playerElement.querySelector('.mediasoup-video-container');
            if (existingContainer) {
                existingContainer.remove();
            }

            const userStreams = clientInstance.remoteUserStreams.get(userId);

            if (userStreams?.videoTrack) {
                log(`User ${userId} has a video track. Creating video element.`, 'debug');
                const videoContainer = document.createElement('div');
                videoContainer.className = 'mediasoup-video-container';

                const videoElement = document.createElement('video');
                videoElement.id = `mediasoup-remote-video-${userId}`;
                videoElement.className = 'mediasoup-remote-video';
                videoElement.autoplay = true;
                videoElement.playsInline = true;
                videoElement.muted = true;

                try {
                    videoElement.srcObject = new MediaStream([userStreams.videoTrack]);
                } catch (e) {
                    log(`Error setting srcObject for user ${userId}: ${e.message}`, 'error');
                }

                videoContainer.appendChild(videoElement);

                // Try multiple insertion points for v13 compatibility
                const insertionTargets = [
                    playerElement.querySelector('.player-name'),
                    playerElement.querySelector('.player-title'),
                    playerElement.querySelector('h3'),
                    playerElement.querySelector('.name'),
                    playerElement.querySelector('label'),
                ].filter(Boolean);

                let inserted = false;
                for (const target of insertionTargets) {
                    if (target) {
                        target.insertAdjacentElement('afterend', videoContainer);
                        inserted = true;
                        break;
                    }
                }

                // Fallback: append to player element
                if (!inserted) {
                    playerElement.appendChild(videoContainer);
                }
            }
        });
    });
}
