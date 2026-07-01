import { describe, expect, it } from 'vitest';
import {
  APP_DATA_TAG_MIC,
  APP_DATA_TAG_WEBCAM,
  CONNECTION_TIMEOUT_MS,
  LOG_PREFIX,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
  MODULE_ID,
  MODULE_TITLE,
  SETTING_AUTO_CONNECT,
  SETTING_DEBUG_LOGGING,
  SETTING_DEFAULT_AUDIO_DEVICE,
  SETTING_DEFAULT_VIDEO_DEVICE,
  SETTING_MEDIASOUP_AUTH_TOKEN,
  SETTING_MEDIASOUP_URL,
  SIG_MSG_TYPES,
  SIGNALING_REQUEST_TIMEOUT_MS,
} from '../../src/constants/index';

describe('module identity', () => {
  it('MODULE_ID matches the Foundry manifest id / install folder', () => {
    // Must stay in sync with module.json `id` and the dist output path.
    expect(MODULE_ID).toBe('mediasoup-vtt');
  });

  it('LOG_PREFIX is derived from the module title', () => {
    expect(MODULE_TITLE).toBe('MediaSoupVTT');
    expect(LOG_PREFIX).toBe(`${MODULE_TITLE} |`);
    expect(LOG_PREFIX).toBe('MediaSoupVTT |');
  });
});

describe('persisted setting keys', () => {
  // These strings are persisted in each client's/world's Foundry settings
  // store; renaming any of them silently orphans existing saved values.
  it('are the exact stable keys the module registers and reads', () => {
    expect(SETTING_MEDIASOUP_URL).toBe('mediaSoupServerUrl');
    expect(SETTING_MEDIASOUP_AUTH_TOKEN).toBe('mediaSoupAuthToken');
    expect(SETTING_AUTO_CONNECT).toBe('autoConnect');
    expect(SETTING_DEFAULT_AUDIO_DEVICE).toBe('defaultAudioDevice');
    expect(SETTING_DEFAULT_VIDEO_DEVICE).toBe('defaultVideoDevice');
    expect(SETTING_DEBUG_LOGGING).toBe('debugLogging');
  });

  it('are all unique', () => {
    const keys = [
      SETTING_MEDIASOUP_URL,
      SETTING_MEDIASOUP_AUTH_TOKEN,
      SETTING_AUTO_CONNECT,
      SETTING_DEFAULT_AUDIO_DEVICE,
      SETTING_DEFAULT_VIDEO_DEVICE,
      SETTING_DEBUG_LOGGING,
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('media kinds and app-data tags', () => {
  it('media kinds match the WebRTC track kinds', () => {
    expect(MEDIA_KIND_AUDIO).toBe('audio');
    expect(MEDIA_KIND_VIDEO).toBe('video');
  });

  it('producer app-data tags are the mic/webcam identifiers', () => {
    expect(APP_DATA_TAG_MIC).toBe('mic');
    expect(APP_DATA_TAG_WEBCAM).toBe('webcam');
  });
});

describe('timeouts', () => {
  it('are positive millisecond values with connect >= per-request', () => {
    expect(CONNECTION_TIMEOUT_MS).toBe(15000);
    expect(SIGNALING_REQUEST_TIMEOUT_MS).toBe(10000);
    expect(CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SIGNALING_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CONNECTION_TIMEOUT_MS).toBeGreaterThanOrEqual(SIGNALING_REQUEST_TIMEOUT_MS);
  });
});

describe('signaling message-type contract', () => {
  // SIG_MSG_TYPES values are the on-the-wire `type` field exchanged with the
  // Rust SFU server; the values (not the key names) are the protocol.
  it('exposes exactly the expected message types', () => {
    expect(SIG_MSG_TYPES).toEqual({
      AUTHENTICATE: 'authenticate',
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
    });
  });

  it('has unique wire values (no two message types collide)', () => {
    const values = Object.values(SIG_MSG_TYPES);
    expect(new Set(values).size).toBe(values.length);
  });
});
