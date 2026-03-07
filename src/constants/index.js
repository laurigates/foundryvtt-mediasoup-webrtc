/**
 * Constants for the MediaSoupVTT plugin
 */

export const MODULE_ID = 'mediasoup-vtt';
export const MODULE_TITLE = 'MediaSoupVTT';
export const LOG_PREFIX = `${MODULE_TITLE} |`;

// Settings keys
export const SETTING_MEDIASOUP_URL = 'mediaSoupServerUrl';
export const SETTING_AUTO_CONNECT = 'autoConnect';
export const SETTING_DEFAULT_AUDIO_DEVICE = 'defaultAudioDevice';
export const SETTING_DEFAULT_VIDEO_DEVICE = 'defaultVideoDevice';
export const SETTING_DEBUG_LOGGING = 'debugLogging';

// Media track kinds
export const MEDIA_KIND_AUDIO = 'audio';
export const MEDIA_KIND_VIDEO = 'video';

// AppData tags for producers
export const APP_DATA_TAG_MIC = 'mic';
export const APP_DATA_TAG_WEBCAM = 'webcam';

// Timeout values (ms)
export const CONNECTION_TIMEOUT_MS = 15000;
export const SIGNALING_REQUEST_TIMEOUT_MS = 10000;

// Signaling message types
export const SIG_MSG_TYPES = {
    GET_ROUTER_RTP_CAPABILITIES: 'getRouterRtpCapabilities',
    ROUTER_RTP_CAPABILITIES: 'routerRtpCapabilities',
    CREATE_WEBRTC_TRANSPORT: 'createWebRtcTransport',
    TRANSPORT_CREATED: 'transportCreated',
    CONNECT_TRANSPORT: 'connectTransport',
    TRANSPORT_CONNECTED: 'transportConnected',
    PRODUCE: 'produce',
    PRODUCED: 'produced',
    NEW_PRODUCER: 'newProducer',
    CONSUME: 'consume',
    CONSUMED: 'consumed',
    PRODUCER_CLOSED: 'producerClosed',
    PAUSE_PRODUCER: 'pauseProducer',
    RESUME_PRODUCER: 'resumeProducer',
    CONSUMER_PAUSE: 'consumerPause',
    CONSUMER_RESUME: 'consumerResume',
    CONSUMER_CLOSE: 'consumerClose',
};
