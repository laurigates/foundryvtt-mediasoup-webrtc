/**
 * Constants for the MediaSoupVTT plugin
 */

export const MODULE_ID = 'mediasoup-vtt';
export const MODULE_TITLE = 'MediaSoupVTT';
export const LOG_PREFIX = `${MODULE_TITLE} |`;

// Settings keys (the module registers only these three)
export const SETTING_MEDIASOUP_URL = 'mediaSoupServerUrl';
export const SETTING_MEDIASOUP_AUTH_TOKEN = 'mediaSoupAuthToken';
export const SETTING_DEBUG_LOGGING = 'debugLogging';

// Media track kinds
export const MEDIA_KIND_AUDIO = 'audio';
export const MEDIA_KIND_VIDEO = 'video';

// AppData tags for producers
export const APP_DATA_TAG_MIC = 'mic';
export const APP_DATA_TAG_WEBCAM = 'webcam';

/** The app-data tag that identifies a local producer (one per media kind). */
export type MediaTag = typeof APP_DATA_TAG_MIC | typeof APP_DATA_TAG_WEBCAM;

// Timeout values (ms)
export const CONNECTION_TIMEOUT_MS = 15000;
export const SIGNALING_REQUEST_TIMEOUT_MS = 10000;

// Reconnect after an unexpected signaling loss: exponential backoff with
// jitter, between the base and the max delay, for at most this many attempts.
export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30000;
export const RECONNECT_MAX_ATTEMPTS = 8;

// ICE recovery: how long a transport may sit in `disconnected` before an ICE
// restart, and how many restarts are tried before a full reconnect.
export const ICE_DISCONNECTED_GRACE_MS = 3000;
export const ICE_RESTART_MAX_ATTEMPTS = 2;

/**
 * WebSocket close code the server sends when a newer connection for the same
 * user joins the room (a reload or a second tab). The replaced client must not
 * reconnect, or the two connections would keep evicting each other.
 */
export const CLOSE_CODE_REPLACED = 4001;

// Signaling message types. The values are the on-the-wire `type` field; each
// request type has a match arm in `server/src/server.rs`, and each
// notification type is sent by `server/src/room.rs`.
export const SIG_MSG_TYPES = {
  // Requests (client -> server, answered with `{requestId, data | error}`)
  AUTHENTICATE: 'authenticate',
  GET_ROUTER_RTP_CAPABILITIES: 'getRouterRtpCapabilities',
  CREATE_WEBRTC_TRANSPORT: 'createWebRtcTransport',
  CONNECT_TRANSPORT: 'connectTransport',
  RESTART_ICE: 'restartIce',
  PRODUCE: 'produce',
  GET_PRODUCERS: 'getProducers',
  CLOSE_PRODUCER: 'closeProducer',
  PAUSE_PRODUCER: 'pauseProducer',
  RESUME_PRODUCER: 'resumeProducer',
  CONSUME: 'consume',
  CONSUMER_RESUME: 'consumerResume',
  CLOSE_CONSUMER: 'closeConsumer',
  // Notifications (server -> client)
  NEW_PRODUCER: 'newProducer',
  PRODUCER_CLOSED: 'producerClosed',
  PRODUCER_PAUSED: 'producerPaused',
  PRODUCER_RESUMED: 'producerResumed',
} as const;
