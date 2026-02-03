/**
 * MediaSoup WebRTC Client for FoundryVTT
 */

import {
    MODULE_ID, MODULE_TITLE,
    SETTING_MEDIASOUP_URL, SETTING_DEFAULT_AUDIO_DEVICE, SETTING_DEFAULT_VIDEO_DEVICE,
    MEDIA_KIND_AUDIO, MEDIA_KIND_VIDEO,
    APP_DATA_TAG_MIC, APP_DATA_TAG_WEBCAM,
    SIG_MSG_TYPES
} from '../constants/index.js';
import { log } from '../utils/logger.js';

export class MediaSoupVTTClient {
    constructor() {
        this.device = null;
        this.socket = null;
        this.sendTransport = null;
        this.recvTransport = null;
        this.producers = new Map();
        this.consumers = new Map();

        // Optimization: Direct mappings to avoid O(n) lookups
        this.producerToConsumerMap = new Map(); // producerId -> consumerId for fast lookup
        this.consumerToUserMap = new Map(); // consumerId -> userId for fast user lookup

        // Initialize server URL as empty - will be updated later when settings are available
        this.serverUrl = '';

        this.isConnected = false;
        this.isConnecting = false;
        this.requestMap = new Map();
        this.requestIdCounter = 0;

        this.localAudioStream = null;
        this.localVideoStream = null;
        this.remoteUserStreams = new Map();

        if (!window.mediasoupClient) {
            log('mediasoup-client library is not loaded. This plugin will not function.', 'error', true);
            if (typeof ui !== 'undefined' && ui.notifications) {
                ui.notifications.error(`${MODULE_TITLE}: mediasoup-client library not found! Critical error.`, { permanent: true });
            }
        }

        log('MediaSoupVTTClient constructor completed successfully', 'debug');
    }

    /**
     * Update server URL from settings after construction
     */
    updateServerUrl() {
        try {
            this.serverUrl = game?.settings?.get(MODULE_ID, SETTING_MEDIASOUP_URL) || '';
            log(`Server URL updated to: ${this.serverUrl}`, 'debug');
        } catch (error) {
            log(`Error getting server URL from settings: ${error.message}`, 'warn');
            this.serverUrl = '';
        }
    }

    async connect() {
        if (this.isConnected || this.isConnecting) {
            log(`Cannot connect. Already connected or connecting. Connected: ${this.isConnected}, Connecting: ${this.isConnecting}`, 'warn');
            return;
        }
        if (!this.serverUrl) {
            const errorMsg = 'MediaSoup server URL is not configured.';
            log(errorMsg, 'warn', true);
            ui.notifications.warn(`${MODULE_TITLE}: MediaSoup server URL not configured. Please set it in module settings.`);
            throw new Error(errorMsg);
        }

        // Validate URL format
        try {
            const url = new URL(this.serverUrl);
            if (!['ws:', 'wss:'].includes(url.protocol)) {
                throw new Error(`Invalid protocol: ${url.protocol}. Must be ws: or wss:`);
            }
        } catch (urlError) {
            const errorMsg = `Invalid server URL format: ${urlError.message}`;
            log(errorMsg, 'error', true);
            ui.notifications.error(`${MODULE_TITLE}: ${errorMsg}`);
            throw new Error(errorMsg);
        }
        if (!window.mediasoupClient) {
            log('mediasoup-client library not found. Cannot connect.', 'error', true);
            ui.notifications.error(`${MODULE_TITLE}: mediasoup-client library not available. Cannot connect.`);
            return;
        }

        this.isConnecting = true;
        this._updateConnectionStatus('connecting');
        log(`Attempting to connect to MediaSoup server at ${this.serverUrl}...`);

        // Create connection timeout - 15 seconds
        const connectionTimeout = setTimeout(() => {
            if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
                log('WebSocket connection timeout after 15 seconds', 'error', true);
                ui.notifications.error(`${MODULE_TITLE}: Connection timeout. Check server availability.`);

                // Clean up socket and trigger failure handling
                this.socket.onopen = null;
                this.socket.onmessage = null;
                this.socket.onerror = null;
                this.socket.onclose = null;
                this.socket.close();
                this.socket = null;

                this._handleConnectionFailure();
            }
        }, 15000);

        try {
            this.socket = new WebSocket(this.serverUrl);
            this.socket.onopen = async () => {
                clearTimeout(connectionTimeout);
                log('WebSocket connection established.', 'info');
                await this._initializeMediasoupDevice();
            };
            this.socket.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this._handleSignalingMessage(message);
                } catch (error) {
                    log(`Error parsing signaling message: ${error.message}`, 'error');
                    console.error('Raw message data:', event.data);
                }
            };
            this.socket.onerror = (error) => {
                clearTimeout(connectionTimeout);
                log(`WebSocket error: ${error.message || 'Unknown error'}`, 'error', true);
                console.error('WebSocket error object:', error);
                ui.notifications.error(`${MODULE_TITLE}: WebSocket connection error.`);
                this._handleConnectionFailure();
            };
            this.socket.onclose = (event) => {
                clearTimeout(connectionTimeout);
                log(`WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason || 'No reason given'}`, event.wasClean ? 'info' : 'warn');
                if (!event.wasClean) {
                    ui.notifications.warn(`${MODULE_TITLE}: WebSocket connection closed unexpectedly.`);
                }
                this._handleConnectionFailure();
            };
        } catch (error) {
            clearTimeout(connectionTimeout);
            log(`Failed to initiate WebSocket connection: ${error.message}`, 'error', true);
            ui.notifications.error(`${MODULE_TITLE}: Failed to initiate connection.`);
            this._handleConnectionFailure();
        }
    }

    disconnect(showNotification = true) {
        log('Disconnecting from MediaSoup server...', 'info');
        this.isConnecting = false;

        this.stopLocalAudio(false);
        this.stopLocalVideo(false);

        if (this.socket) {
            // Clear all event handlers to prevent memory leaks
            this.socket.onopen = null;
            this.socket.onmessage = null;
            this.socket.onerror = null;
            this.socket.onclose = null;

            if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
                this.socket.close();
            }
            this.socket = null;
        }

        this.producers.forEach(p => { if (p && !p.closed) p.close(); });
        this.producers.clear();

        this.consumers.forEach(consumer => {
            if (consumer && !consumer.closed) consumer.close();
            // Optimized lookup: Use direct mapping instead of O(n) search
            const userId = this.consumerToUserMap.get(consumer.id);
            if (userId) {
                if (consumer.kind === MEDIA_KIND_AUDIO) {
                    const audioElement = document.getElementById(`mediasoup-consumer-audio-${userId}`);
                    if (audioElement) audioElement.remove();
                }
                else if (consumer.kind === MEDIA_KIND_VIDEO) this._removeRemoteVideoElement(userId);
            }
        });
        this.consumers.clear();

        // Clear optimization mappings
        this.producerToConsumerMap.clear();
        this.consumerToUserMap.clear();
        this.remoteUserStreams.clear();

        if (this.sendTransport && !this.sendTransport.closed) {
            this.sendTransport.close();
            this.sendTransport = null;
        }
        if (this.recvTransport && !this.recvTransport.closed) {
            this.recvTransport.close();
            this.recvTransport = null;
        }

        this.device = null;
        this.requestMap.forEach(({ reject }) => reject(new Error('Disconnecting.')));
        this.requestMap.clear();
        this.requestIdCounter = 0;

        if (this.localAudioStream) {
            this.localAudioStream.getTracks().forEach(track => track.stop());
            this.localAudioStream = null;
        }
        if (this.localVideoStream) {
            this.localVideoStream.getTracks().forEach(track => track.stop());
            this.localVideoStream = null;
        }
        this._removeLocalVideoPreview();

        if (this.isConnected && showNotification) {
            ui.notifications.info(`${MODULE_TITLE}: Disconnected from MediaSoup server.`);
        }
        this.isConnected = false;
        this._updateConnectionStatus('disconnected');
        ui.players.render(true);
    }

    _handleConnectionFailure() {
        this.isConnecting = false;
        if (this.isConnected) {
            ui.notifications.info(`${MODULE_TITLE}: Disconnected from MediaSoup server.`);
        }
        this.disconnect(false);
        this._updateConnectionStatus('error');
    }

    async _initializeMediasoupDevice() {
        try {
            log('Initializing mediasoup-client Device...');
            this.device = new window.mediasoupClient.Device();
            const routerRtpCapabilities = await this._sendSignalingRequest({ type: SIG_MSG_TYPES.GET_ROUTER_RTP_CAPABILITIES });
            if (!routerRtpCapabilities || Object.keys(routerRtpCapabilities).length === 0) {
                throw new Error('Received empty or invalid routerRtpCapabilities from server.');
            }
            log('Received Router RTP Capabilities. Loading into device...', 'debug');
            await this.device.load({ routerRtpCapabilities });
            log('Mediasoup Device loaded successfully.', 'info');

            await this._createSendTransport();
            await this._createRecvTransport();

            this.isConnected = true;
            this.isConnecting = false;
            this._updateConnectionStatus('connected');
            ui.notifications.info(`${MODULE_TITLE}: Successfully connected to MediaSoup server.`);
            await this._populateDeviceSettings();
            ui.players.render(true);

        } catch (error) {
            log(`Error initializing MediaSoup Device: ${error.message}`, 'error', true);
            console.error(error);
            ui.notifications.error(`${MODULE_TITLE}: Initialization failed - ${error.message}`);
            this._handleConnectionFailure();
        }
    }

    _sendSignalingRequest(requestData, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                return reject(new Error('WebSocket is not open.'));
            }
            const requestId = `req_${this.requestIdCounter++}`;
            const message = { ...requestData, requestId, userId: game.userId };

            this.requestMap.set(requestId, { resolve, reject });
            log(`Sending signaling request (ID: ${requestId}): ${JSON.stringify(requestData)}`, 'debug');
            this.socket.send(JSON.stringify(message));

            setTimeout(() => {
                if (this.requestMap.has(requestId)) {
                    this.requestMap.delete(requestId);
                    log(`Signaling request (ID: ${requestId}, Type: ${requestData.type}) timed out.`, 'warn');
                    reject(new Error(`Request '${requestData.type}' timed out`));
                }
            }, timeoutMs);
        });
    }

    _handleSignalingMessage(message) {
        log(`Received signaling message: ${JSON.stringify(message)}`, 'debug');
        if (message.requestId && this.requestMap.has(message.requestId)) {
            const { resolve, reject } = this.requestMap.get(message.requestId);
            if (message.error) {
                log(`Signaling request (ID: ${message.requestId}) failed: ${message.error}`, 'error');
                reject(new Error(message.error));
            } else {
                resolve(message.data || message);
            }
            this.requestMap.delete(message.requestId);
            return;
        }
        switch (message.type) {
        case SIG_MSG_TYPES.NEW_PRODUCER:
            log(`Server notified of new producer: ${message.producerId} for user ${message.userId} of kind ${message.kind}`, 'info');
            this._handleNewRemoteProducer(message);
            break;
        case SIG_MSG_TYPES.PRODUCER_CLOSED:
            log(`Server notified producer closed: ${message.producerId}`, 'info');
            this._handleRemoteProducerClosed(message.producerId);
            break;
        default:
            log(`Received unhandled signaling message type: ${message.type}`, 'warn');
        }
    }

    async _createSendTransport() {
        try {
            log('Requesting server to create send transport...', 'debug');
            const transportInfo = await this._sendSignalingRequest({
                type: SIG_MSG_TYPES.CREATE_WEBRTC_TRANSPORT,
                forceTcp: false,
                producing: true,
                consuming: false,
                sctpCapabilities: this.device.sctpCapabilities
            });

            if (!this.device) throw new Error('Device not initialized for creating send transport.');
            this.sendTransport = this.device.createSendTransport(transportInfo);
            log('Send transport created locally.', 'debug');

            this.sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                log('Send transport "connect" event triggered.', 'debug');
                try {
                    await this._sendSignalingRequest({
                        type: SIG_MSG_TYPES.CONNECT_TRANSPORT,
                        transportId: this.sendTransport.id,
                        dtlsParameters
                    });
                    callback();
                    log('Send transport connected to server.', 'info');
                } catch (error) {
                    log(`Error connecting send transport: ${error.message}`, 'error');
                    errback(error);
                }
            });

            this.sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
                log(`Send transport "produce" event triggered for kind: ${kind}`, 'debug');
                try {
                    const { id } = await this._sendSignalingRequest({
                        type: SIG_MSG_TYPES.PRODUCE,
                        transportId: this.sendTransport.id,
                        kind,
                        rtpParameters,
                        appData
                    });
                    callback({ id });
                    log(`Successfully produced ${kind} (Producer ID: ${id}, AppData: ${JSON.stringify(appData)})`, 'info');
                } catch (error) {
                    log(`Error on "produce" event for send transport: ${error.message}`, 'error');
                    errback(error);
                }
            });

            this.sendTransport.on('connectionstatechange', (state) => {
                log(`Send transport connection state changed: ${state}`, 'debug');
                if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                    log(`Send transport entered critical state: ${state}.`, 'warn');
                }
            });

        } catch (error) {
            log(`Error creating send transport: ${error.message}`, 'error', true);
            ui.notifications.error(`${MODULE_TITLE}: Could not create send transport - ${error.message}`);
            this._handleConnectionFailure();
        }
    }

    async _createRecvTransport() {
        try {
            log('Requesting server to create receive transport...', 'debug');
            const transportInfo = await this._sendSignalingRequest({
                type: SIG_MSG_TYPES.CREATE_WEBRTC_TRANSPORT,
                forceTcp: false,
                producing: false,
                consuming: true,
                sctpCapabilities: this.device.sctpCapabilities
            });

            if (!this.device) throw new Error('Device not initialized for creating recv transport.');
            this.recvTransport = this.device.createRecvTransport(transportInfo);
            log('Receive transport created locally.', 'debug');

            this.recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                log('Receive transport "connect" event triggered.', 'debug');
                try {
                    await this._sendSignalingRequest({
                        type: SIG_MSG_TYPES.CONNECT_TRANSPORT,
                        transportId: this.recvTransport.id,
                        dtlsParameters
                    });
                    callback();
                    log('Receive transport connected to server.', 'info');
                } catch (error) {
                    log(`Error connecting receive transport: ${error.message}`, 'error');
                    errback(error);
                }
            });

            this.recvTransport.on('connectionstatechange', (state) => {
                log(`Receive transport connection state changed: ${state}`, 'debug');
                if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                    log(`Receive transport entered critical state: ${state}.`, 'warn');
                }
            });

        } catch (error) {
            log(`Error creating receive transport: ${error.message}`, 'error', true);
            ui.notifications.error(`${MODULE_TITLE}: Could not create receive transport - ${error.message}`);
            this._handleConnectionFailure();
        }
    }

    async startLocalAudio(testMode = false) {
        // Check if we already have audio producer
        if (this.producers.has(APP_DATA_TAG_MIC)) {
            log('Audio already started.', 'info');
            const producer = this.producers.get(APP_DATA_TAG_MIC);
            if (producer.paused) await this.resumeProducer(producer);
            return {
                success: true,
                alreadyStarted: true,
                hasProducer: true,
                hasStream: !!this.localAudioStream,
                producer: producer
            };
        }

        // In test mode, we can capture local streams without full MediaSoup setup
        const canProduce = testMode || (this.isConnected && this.sendTransport && this.device?.canProduce(MEDIA_KIND_AUDIO));

        if (!testMode && (!this.isConnected || !this.sendTransport || !this.device?.canProduce(MEDIA_KIND_AUDIO))) {
            log('Cannot start local audio: Not connected, send transport not ready, or cannot produce audio.', 'warn');
            ui.notifications?.warn(`${MODULE_TITLE}: Cannot start audio. Not ready.`);
            return {
                success: false,
                error: 'Not connected or cannot produce audio',
                hasProducer: false,
                hasStream: false
            };
        }

        log('Starting local audio capture...', 'info');
        try {
            const deviceId = game?.settings?.get(MODULE_ID, SETTING_DEFAULT_AUDIO_DEVICE);
            const constraints = { audio: deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true };
            log(`Using audio constraints: ${JSON.stringify(constraints)}`, 'debug');

            this.localAudioStream = await navigator.mediaDevices.getUserMedia(constraints);
            const track = this.localAudioStream.getAudioTracks()[0];
            if (!track) throw new Error('No audio track found in stream.');

            // Only create producer if we have full MediaSoup setup (not in test mode)
            if (canProduce && this.sendTransport) {
                const producer = await this.sendTransport.produce({
                    track,
                    appData: { mediaTag: APP_DATA_TAG_MIC, userId: game.userId }
                });
                this.producers.set(APP_DATA_TAG_MIC, producer);
                log(`Audio producer created (ID: ${producer.id})`, 'info');
                this._updateMediaButtonState(APP_DATA_TAG_MIC, true, producer.paused);

                producer.on('trackended', () => {
                    log('Audio track ended (e.g., device unplugged).', 'warn');
                    this.stopLocalAudio(true);
                });
                producer.on('transportclose', () => {
                    log('Audio producer transport closed.', 'warn');
                    this.producers.delete(APP_DATA_TAG_MIC);
                    this._updateMediaButtonState(APP_DATA_TAG_MIC, false, false);
                    if (this.localAudioStream) {
                        this.localAudioStream.getTracks().forEach(t => t.stop());
                        this.localAudioStream = null;
                    }
                });
            } else {
                log('Audio stream captured successfully (test mode - no producer created)', 'info');
            }

            return {
                success: true,
                hasProducer: this.producers.has(APP_DATA_TAG_MIC),
                hasStream: !!this.localAudioStream,
                testMode,
                producer: this.producers.get(APP_DATA_TAG_MIC) || null
            };

        } catch (error) {
            log(`Error starting local audio: ${error.message}`, 'error', true);
            ui.notifications.error(`${MODULE_TITLE}: Could not start microphone - ${error.message}`);
            if (this.localAudioStream) {
                this.localAudioStream.getTracks().forEach(t => t.stop());
                this.localAudioStream = null;
            }
            return {
                success: false,
                error: error.message,
                hasProducer: false,
                hasStream: false
            };
        }
    }

    async stopLocalAudio(_notifyServer = true) {
        const producer = this.producers.get(APP_DATA_TAG_MIC);
        if (!producer) {
            log('No local audio producer to stop.', 'debug');
            return;
        }
        log('Stopping local audio...', 'info');
        if (!producer.closed) {
            producer.close();
        }

        if (this.producers.has(APP_DATA_TAG_MIC)) {
            this.producers.delete(APP_DATA_TAG_MIC);
            this._updateMediaButtonState(APP_DATA_TAG_MIC, false, false);
        }

        if (this.localAudioStream) {
            this.localAudioStream.getTracks().forEach(track => track.stop());
            this.localAudioStream = null;
        }
    }

    async toggleAudioMute() {
        const producer = this.producers.get(APP_DATA_TAG_MIC);
        if (!producer || producer.closed) {
            log('Cannot toggle mute: No active audio producer. Attempting to start audio.', 'info');
            await this.startLocalAudio();
            return { success: true, hasProducer: this.producers.has(APP_DATA_TAG_MIC) };
        }

        const wasUnmuted = !producer.paused;
        log(`Toggling audio mute. Current state: ${wasUnmuted ? 'unmuted' : 'muted'}`, 'debug');

        try {
            if (producer.paused) {
                await this.resumeProducer(producer);
                log('Audio unmuted successfully', 'info');
            } else {
                await this.pauseProducer(producer);
                log('Audio muted successfully', 'info');
            }

            // Verify final state and ensure UI is synchronized
            const finalState = !producer.paused;
            this._updateMediaButtonState(APP_DATA_TAG_MIC, true, producer.paused);

            return {
                success: true,
                hasProducer: true,
                wasUnmuted,
                isUnmuted: finalState
            };

        } catch (error) {
            log(`Error toggling audio mute: ${error.message}`, 'error');
            // Restore UI state based on actual producer state
            this._updateMediaButtonState(APP_DATA_TAG_MIC, true, producer.paused);
            return { success: false, hasProducer: true, error: error.message };
        }
    }

    async startLocalVideo(testMode = false) {
        // Check if we already have video producer
        if (this.producers.has(APP_DATA_TAG_WEBCAM)) {
            log('Video already started.', 'info');
            const producer = this.producers.get(APP_DATA_TAG_WEBCAM);
            if (producer.paused) await this.resumeProducer(producer);
            return {
                success: true,
                alreadyStarted: true,
                hasProducer: true,
                hasStream: !!this.localVideoStream,
                producer: producer
            };
        }

        // In test mode, we can capture local streams without full MediaSoup setup
        const canProduce = testMode || (this.isConnected && this.sendTransport && this.device?.canProduce(MEDIA_KIND_VIDEO));

        if (!testMode && (!this.isConnected || !this.sendTransport || !this.device?.canProduce(MEDIA_KIND_VIDEO))) {
            log('Cannot start local video: Not connected, send transport not ready, or cannot produce video.', 'warn');
            ui.notifications?.warn(`${MODULE_TITLE}: Cannot start video. Not ready.`);
            return {
                success: false,
                error: 'Not connected or cannot produce video',
                hasProducer: false,
                hasStream: false
            };
        }

        log('Starting local video capture...', 'info');
        try {
            const deviceId = game?.settings?.get(MODULE_ID, SETTING_DEFAULT_VIDEO_DEVICE);
            const constraints = { video: deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true };
            log(`Using video constraints: ${JSON.stringify(constraints)}`, 'debug');

            this.localVideoStream = await navigator.mediaDevices.getUserMedia(constraints);
            const track = this.localVideoStream.getVideoTracks()[0];
            if (!track) throw new Error('No video track found in stream.');

            // Only create producer if we have full MediaSoup setup (not in test mode)
            if (canProduce && this.sendTransport) {
                const producer = await this.sendTransport.produce({
                    track,
                    encodings: [],
                    appData: { mediaTag: APP_DATA_TAG_WEBCAM, userId: game.userId }
                });
                this.producers.set(APP_DATA_TAG_WEBCAM, producer);
                log(`Video producer created (ID: ${producer.id})`, 'info');
                this._updateMediaButtonState(APP_DATA_TAG_WEBCAM, true, producer.paused);
                this._displayLocalVideoPreview(this.localVideoStream);

                producer.on('trackended', () => {
                    log('Video track ended.', 'warn');
                    this.stopLocalVideo(true);
                });
                producer.on('transportclose', () => {
                    log('Video producer transport closed.', 'warn');
                    this.producers.delete(APP_DATA_TAG_WEBCAM);
                    this._updateMediaButtonState(APP_DATA_TAG_WEBCAM, false, false);
                    this._removeLocalVideoPreview();
                    if (this.localVideoStream) {
                        this.localVideoStream.getTracks().forEach(t => t.stop());
                        this.localVideoStream = null;
                    }
                });
            } else {
                log('Video stream captured successfully (test mode - no producer created)', 'info');
                this._displayLocalVideoPreview(this.localVideoStream);
            }

            return {
                success: true,
                hasProducer: this.producers.has(APP_DATA_TAG_WEBCAM),
                hasStream: !!this.localVideoStream,
                testMode,
                producer: this.producers.get(APP_DATA_TAG_WEBCAM) || null
            };

        } catch (error) {
            log(`Error starting local video: ${error.message}`, 'error', true);
            ui.notifications.error(`${MODULE_TITLE}: Could not start webcam - ${error.message}`);
            if (this.localVideoStream) {
                this.localVideoStream.getTracks().forEach(t => t.stop());
                this.localVideoStream = null;
            }
            this._removeLocalVideoPreview();
            return {
                success: false,
                error: error.message,
                hasProducer: false,
                hasStream: false
            };
        }
    }

    async stopLocalVideo(_notifyServer = true) {
        const producer = this.producers.get(APP_DATA_TAG_WEBCAM);
        if (!producer) {
            log('No local video producer to stop.', 'debug');
            return;
        }
        log('Stopping local video...', 'info');
        if (!producer.closed) {
            producer.close();
        }

        if (this.producers.has(APP_DATA_TAG_WEBCAM)) {
            this.producers.delete(APP_DATA_TAG_WEBCAM);
            this._updateMediaButtonState(APP_DATA_TAG_WEBCAM, false, false);
        }

        if (this.localVideoStream) {
            this.localVideoStream.getTracks().forEach(track => track.stop());
            this.localVideoStream = null;
        }
        this._removeLocalVideoPreview();
    }

    async toggleVideoEnabled() {
        const producer = this.producers.get(APP_DATA_TAG_WEBCAM);
        if (!producer || producer.closed) {
            log('No active video producer to toggle. Attempting to start video.', 'info');
            await this.startLocalVideo();
            return;
        }
        if (producer.paused) {
            await this.resumeProducer(producer);
            this._displayLocalVideoPreview(this.localVideoStream);
        } else {
            await this.pauseProducer(producer);
            this._removeLocalVideoPreview();
        }
    }

    async pauseProducer(producer) {
        if (!producer || producer.closed || producer.paused) return;
        log(`Pausing producer ${producer.id} (Kind: ${producer.kind}, AppData: ${JSON.stringify(producer.appData)})`, 'info');
        try {
            await producer.pause();
            log(`Producer ${producer.id} paused.`, 'info');
            this._updateMediaButtonState(producer.appData.mediaTag, true, true);

            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this._sendSignalingRequest({ type: SIG_MSG_TYPES.PAUSE_PRODUCER, producerId: producer.id })
                    .catch(e => log(`Error notifying server of producer pause: ${e.message}`, 'warn'));
            }
        } catch (error) {
            log(`Error pausing producer ${producer.id}: ${error.message}`, 'error');
        }
    }

    async resumeProducer(producer) {
        if (!producer || producer.closed || !producer.paused) return;
        log(`Resuming producer ${producer.id} (Kind: ${producer.kind}, AppData: ${JSON.stringify(producer.appData)})`, 'info');
        try {
            await producer.resume();
            log(`Producer ${producer.id} resumed.`, 'info');
            this._updateMediaButtonState(producer.appData.mediaTag, true, false);

            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this._sendSignalingRequest({ type: SIG_MSG_TYPES.RESUME_PRODUCER, producerId: producer.id })
                    .catch(e => log(`Error notifying server of producer resume: ${e.message}`, 'warn'));
            }
        } catch (error) {
            log(`Error resuming producer ${producer.id}: ${error.message}`, 'error');
        }
    }

    async _handleNewRemoteProducer({ producerId, userId, kind, appData }) {
        if (userId === game.userId) {
            log(`Skipping consumption of own producer ${producerId}`, 'debug');
            return;
        }

        if (!appData || !appData.rtpParameters) {
            const errorMsg = `Cannot consume producer ${producerId}: Missing rtpParameters in appData from server notification.`;
            log(errorMsg, 'error');
            ui.notifications.error('MediaSoup: Failed to consume media stream - server configuration error');
            return;
        }

        if (!this.isConnected || !this.recvTransport || !this.device.canConsume({ producerId, kind, rtpParameters: appData.rtpParameters })) {
            const errorMsg = `Cannot consume new producer ${producerId}: Not ready or device cannot consume. Device consumable check failed.`;
            log(errorMsg, 'warn');
            ui.notifications.warn(`MediaSoup: Unable to receive ${kind} stream from user - device not compatible`);
            return;
        }
        log(`Handling new remote producer ${producerId} of kind ${kind} from user ${userId}`, 'info');

        try {
            const consumerParams = await this._sendSignalingRequest({
                type: SIG_MSG_TYPES.CONSUME,
                producerId: producerId,
                rtpCapabilities: this.device.rtpCapabilities,
            });

            if (!consumerParams || !consumerParams.id) {
                throw new Error('Server did not return valid consumer parameters.');
            }

            const consumer = await this.recvTransport.consume({
                id: consumerParams.id,
                producerId: consumerParams.producerId,
                kind: consumerParams.kind,
                rtpParameters: consumerParams.rtpParameters,
                appData: { ...appData, userId, kind }
            });

            this.consumers.set(consumer.id, consumer);

            // Update optimization mappings for O(1) lookups
            this.producerToConsumerMap.set(producerId, consumer.id);
            this.consumerToUserMap.set(consumer.id, userId);

            log(`Consumer created (ID: ${consumer.id}, Kind: ${kind}) for producer ${producerId}`, 'info');

            let userStreams = this.remoteUserStreams.get(userId) || {};
            if (kind === MEDIA_KIND_AUDIO) {
                userStreams.audioTrack = consumer.track;
                userStreams.audioConsumerId = consumer.id;
                const audioElement = document.createElement('audio');
                audioElement.id = `mediasoup-consumer-audio-${userId}`;
                audioElement.srcObject = new MediaStream([consumer.track]);
                audioElement.autoplay = true;
                document.body.appendChild(audioElement);
                log(`Playing remote audio for user ${userId}, consumer ${consumer.id}`, 'debug');
            } else if (kind === MEDIA_KIND_VIDEO) {
                userStreams.videoTrack = consumer.track;
                userStreams.videoConsumerId = consumer.id;
                log(`Received remote video track for user ${userId}, consumer ${consumer.id}. Attaching to UI.`, 'info');
            }
            this.remoteUserStreams.set(userId, userStreams);

            if (consumerParams.producerPaused) {
                log(`Remote producer ${producerId} is paused. Pausing consumer ${consumer.id}.`, 'info');
            }

            consumer.on('trackended', () => {
                log(`Remote track ended for consumer ${consumer.id}.`, 'warn');
                this._handleRemoteProducerClosed(consumer.producerId);
            });
            consumer.on('transportclose', () => {
                log(`Consumer transport closed for consumer ${consumer.id}.`, 'warn');
                this._handleRemoteProducerClosed(consumer.producerId);
            });

            ui.players.render(true);

        } catch (error) {
            log(`Error consuming producer ${producerId}: ${error.message}`, 'error', true);
            console.error(error);
        }
    }

    _handleRemoteProducerClosed(producerId) {
        // Optimized O(1) lookup instead of O(n) search
        const consumerIdToRemove = this.producerToConsumerMap.get(producerId);
        const consumerToClose = consumerIdToRemove ? this.consumers.get(consumerIdToRemove) : null;

        if (consumerToClose) {
            log(`Closing consumer ${consumerToClose.id} for remote producer ${producerId}`, 'info');
            if (!consumerToClose.closed) {
                consumerToClose.close();
            }
            this.consumers.delete(consumerIdToRemove);

            // Clean up optimization mappings
            this.producerToConsumerMap.delete(producerId);
            this.consumerToUserMap.delete(consumerIdToRemove);

            const userId = consumerToClose.appData.userId;
            const kind = consumerToClose.kind;
            let userStreams = this.remoteUserStreams.get(userId);

            if (userStreams) {
                if (kind === MEDIA_KIND_AUDIO) {
                    const audioElement = document.getElementById(`mediasoup-consumer-audio-${userId}`);
                    if (audioElement) {
                        audioElement.remove();
                    }
                    userStreams.audioTrack = null;
                    userStreams.audioConsumerId = null;
                } else if (kind === MEDIA_KIND_VIDEO) {
                    this._removeRemoteVideoElement(userId);
                    userStreams.videoTrack = null;
                    userStreams.videoConsumerId = null;
                }
                if (!userStreams.audioTrack && !userStreams.videoTrack) {
                    this.remoteUserStreams.delete(userId);
                } else {
                    this.remoteUserStreams.set(userId, userStreams);
                }
            }
            ui.players.render(true);
        } else {
            log(`No active consumer found for producerId ${producerId} to close.`, 'debug');
        }
    }

    // UI helper methods
    _updateConnectionStatus(status) {
        // Update UI elements to reflect connection status
        const statusElement = document.querySelector('#mediasoup-connection-status');
        if (statusElement) {
            statusElement.textContent = status;
            statusElement.className = `mediasoup-status ${status.toLowerCase()}`;
        }

        // Update scene controls if they exist
        const connectButton = document.querySelector('[data-tool="mediasoup-connect"]');
        if (connectButton) {
            connectButton.classList.toggle('active', status === 'connected');
            connectButton.title = `MediaSoup: ${status}`;
        }

        log(`Connection status updated: ${status}`, 'debug');
    }

    _updateMediaButtonState(mediaTag, isActive, isPaused) {
        // Update scene control buttons for audio/video state
        const buttonSelector = `[data-tool="mediasoup-${mediaTag}"]`;
        const button = document.querySelector(buttonSelector);

        if (button) {
            button.classList.toggle('active', isActive);
            button.classList.toggle('paused', isPaused);

            // Update button title/tooltip
            let status = 'off';
            if (isActive && isPaused) status = 'paused';
            else if (isActive) status = 'on';

            button.title = `${mediaTag}: ${status}`;

            // Update icon if it exists
            const icon = button.querySelector('i');
            if (icon) {
                icon.className = `fas fa-${mediaTag === 'audio' ? 'microphone' : 'video'}${isActive ? (isPaused ? '-slash' : '') : '-slash'}`;
            }
        }

        log(`Media button state updated: ${mediaTag} - active: ${isActive}, paused: ${isPaused}`, 'debug');
    }

    _displayLocalVideoPreview(stream) {
        // Remove existing preview
        this._removeLocalVideoPreview();

        if (!stream) return;

        // Create video preview element
        const videoPreview = document.createElement('video');
        videoPreview.id = 'mediasoup-local-video-preview';
        videoPreview.className = 'mediasoup-video-preview';
        videoPreview.autoplay = true;
        videoPreview.playsInline = true;
        videoPreview.muted = true;
        videoPreview.srcObject = stream;

        // Add to document body
        document.body.appendChild(videoPreview);

        log('Local video preview displayed', 'debug');
    }

    _removeLocalVideoPreview() {
        const videoPreview = document.getElementById('mediasoup-local-video-preview');
        if (videoPreview) {
            // Stop all tracks if srcObject exists
            if (videoPreview.srcObject) {
                // Just clear the srcObject to release the element's reference to the stream,
                // but don't stop the tracks as they may still be used by the WebRTC producer.
                videoPreview.srcObject = null;
            }
            videoPreview.remove();
            log('Local video preview removed', 'debug');
        }
    }

    _removeRemoteVideoElement(userId) {
        // Support both v12 and v13 player list structures
        const playerSelectors = [
            `#player-list li[data-user-id="${userId}"]`,
            `#player-list .player[data-user-id="${userId}"]`,
            `.players-list li[data-user-id="${userId}"]`,
            `.players-list .player[data-user-id="${userId}"]`
        ];

        for (const selector of playerSelectors) {
            const playerElement = document.querySelector(selector);
            if (playerElement) {
                const videoContainer = playerElement.querySelector('.mediasoup-video-container');
                if (videoContainer) {
                    videoContainer.remove();
                }
                break;
            }
        }

        // Also remove any standalone audio elements
        const audioElement = document.getElementById(`mediasoup-consumer-audio-${userId}`);
        if (audioElement) {
            audioElement.remove();
        }
    }

    async _populateDeviceSettings() {
        log('Populating device settings...', 'debug');
        try {
            // Request temporary permissions to get device labels if not already granted
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
                stream.getTracks().forEach(track => track.stop());
            } catch (permError) {
                log(`Could not request permissions for device enumeration: ${permError.message}`, 'debug');
                // Continue anyway - we'll get device IDs without labels
            }

            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioDevices = { 'default': 'Browser Default' };
            const videoDevices = { 'default': 'Browser Default' };

            let audioCount = 1;
            let videoCount = 1;

            devices.forEach(device => {
                if (device.kind === 'audioinput' && device.deviceId) {
                    const label = device.label || `Microphone ${audioCount++}`;
                    audioDevices[device.deviceId] = label;
                } else if (device.kind === 'videoinput' && device.deviceId) {
                    const label = device.label || `Camera ${videoCount++}`;
                    videoDevices[device.deviceId] = label;
                }
            });

            // Store for future reference
            this.availableAudioDevices = audioDevices;
            this.availableVideoDevices = videoDevices;

            // Update FoundryVTT game settings choices
            const audioSetting = game.settings.settings.get(`${MODULE_ID}.${SETTING_DEFAULT_AUDIO_DEVICE}`);
            if (audioSetting) {
                audioSetting.choices = audioDevices;
            }

            const videoSetting = game.settings.settings.get(`${MODULE_ID}.${SETTING_DEFAULT_VIDEO_DEVICE}`);
            if (videoSetting) {
                videoSetting.choices = videoDevices;
            }

            log(`Device settings populated successfully. Audio devices: ${Object.keys(audioDevices).length}, Video devices: ${Object.keys(videoDevices).length}`, 'info');
        } catch (error) {
            log(`Error populating device settings: ${error.message}`, 'warn');
            // Set defaults if enumeration fails
            this.availableAudioDevices = { 'default': 'Browser Default' };
            this.availableVideoDevices = { 'default': 'Browser Default' };
        }
    }
}