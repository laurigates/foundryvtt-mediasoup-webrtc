import { describe, expect, it } from 'vitest';
import * as constants from '../../src/constants/index';
import {
  APP_DATA_TAG_MIC,
  APP_DATA_TAG_WEBCAM,
  CLOSE_CODE_REPLACED,
  CONNECTION_TIMEOUT_MS,
  ICE_DISCONNECTED_GRACE_MS,
  ICE_RESTART_MAX_ATTEMPTS,
  LOG_PREFIX,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
  MODULE_ID,
  MODULE_TITLE,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  SETTING_DEBUG_LOGGING,
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
    expect(SETTING_DEBUG_LOGGING).toBe('debugLogging');
  });

  it('no longer export the pre-AVClient keys (devices and auto-connect come from core AVSettings)', () => {
    const exported = constants as Record<string, unknown>;
    expect(exported.SETTING_AUTO_CONNECT).toBeUndefined();
    expect(exported.SETTING_DEFAULT_AUDIO_DEVICE).toBeUndefined();
    expect(exported.SETTING_DEFAULT_VIDEO_DEVICE).toBeUndefined();
  });

  it('are all unique', () => {
    const keys = [SETTING_MEDIASOUP_URL, SETTING_MEDIASOUP_AUTH_TOKEN, SETTING_DEBUG_LOGGING];
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

describe('recovery policy', () => {
  it('reconnects with backoff between 1s and 30s for 8 attempts', () => {
    expect(RECONNECT_BASE_DELAY_MS).toBe(1000);
    expect(RECONNECT_MAX_DELAY_MS).toBe(30000);
    expect(RECONNECT_MAX_ATTEMPTS).toBe(8);
    expect(RECONNECT_MAX_DELAY_MS).toBeGreaterThan(RECONNECT_BASE_DELAY_MS);
  });

  it('waits 3s in ICE disconnected and tries 2 ICE restarts before a full reconnect', () => {
    expect(ICE_DISCONNECTED_GRACE_MS).toBe(3000);
    expect(ICE_RESTART_MAX_ATTEMPTS).toBe(2);
  });

  it('uses the server close code for a replaced connection', () => {
    // Must match CLOSE_CODE_REPLACED in server/src/room.rs.
    expect(CLOSE_CODE_REPLACED).toBe(4001);
  });
});

describe('signaling message-type contract', () => {
  // SIG_MSG_TYPES values are the on-the-wire `type` field exchanged with the
  // Rust SFU server; the values (not the key names) are the protocol.
  it('exposes exactly the expected message types', () => {
    expect(SIG_MSG_TYPES).toEqual({
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
      NEW_PRODUCER: 'newProducer',
      PRODUCER_CLOSED: 'producerClosed',
      PRODUCER_PAUSED: 'producerPaused',
      PRODUCER_RESUMED: 'producerResumed',
    });
  });

  it('drops the reply-type names the request/response protocol never sends', () => {
    const keys = Object.keys(SIG_MSG_TYPES);
    for (const dead of [
      'ROUTER_RTP_CAPABILITIES',
      'TRANSPORT_CREATED',
      'TRANSPORT_CONNECTED',
      'PRODUCED',
      'CONSUMED',
      'CONSUMER_PAUSE',
      'CONSUMER_CLOSE',
    ]) {
      expect(keys).not.toContain(dead);
    }
  });

  it('has unique wire values (no two message types collide)', () => {
    const values = Object.values(SIG_MSG_TYPES);
    expect(new Set(values).size).toBe(values.length);
  });
});
