/**
 * Module load and AVClient contract against the v14-shaped Foundry fake.
 *
 * The list of abstract members comes from the v14 foundry.av.AVClient API
 * page (see V14_AVCLIENT_ABSTRACT_MEMBERS), not from MediaSoupAVClient.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MediaSoupAVClient } from '../../src/client/MediaSoupAVClient';
import { FakeSfu } from './helpers/fake-ws';
import {
  AVClient,
  AVMaster,
  AVSettings,
  foundryEnv,
  LOCAL_USER_ID,
  SimplePeerAVClient,
  seedModuleSettings,
  V14_AVCLIENT_ABSTRACT_MEMBERS,
  V14_AVCLIENT_ARITY,
} from './helpers/foundry-v14';
import { flush, SERVER_URL, TOKEN } from './helpers/peers';

// Core constructs `new CONFIG.WebRTC.clientClass(master, settings)` with no
// transport, so the class builds its own core with `new Device()` and the
// global WebSocket. In happy-dom the Device gets FakeHandler instead of a
// browser handler; everything else is mediasoup-client as shipped.
vi.mock('mediasoup-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mediasoup-client')>();
  class Device extends actual.Device {
    constructor(options: ConstructorParameters<typeof actual.Device>[0] = {}) {
      super({
        handlerFactory: actual.FakeHandler.createFactory(actual.testFakeParameters),
        ...options,
      });
    }
  }
  return { ...actual, Device };
});

const env = foundryEnv();
const ABSTRACT = Object.keys(V14_AVCLIENT_ABSTRACT_MEMBERS) as Array<
  keyof typeof V14_AVCLIENT_ABSTRACT_MEMBERS
>;

describe('module entry (src/mediasoup-vtt.ts)', () => {
  const before = { clientClass: undefined as unknown };

  beforeAll(async () => {
    before.clientClass = env.CONFIG.WebRTC.clientClass;
    await import('../../src/mediasoup-vtt');
  });

  it('replaces core SimplePeerAVClient with MediaSoupAVClient as CONFIG.WebRTC.clientClass on import', () => {
    expect(before.clientClass).toBe(SimplePeerAVClient);
    expect(env.CONFIG.WebRTC.clientClass).toBe(MediaSoupAVClient);
  });

  it('registers exactly one init and one ready hook, and no v12-era UI hooks', () => {
    expect(env.hooks.handlers('init')).toHaveLength(1);
    expect(env.hooks.handlers('ready')).toHaveLength(1);
    expect(env.hooks.handlers('init')[0]?.once).toBe(true);
    for (const legacy of [
      'getSceneControlButtons',
      'renderPlayerList',
      'renderSceneControls',
      'renderCameraViews',
    ]) {
      expect(env.hooks.handlers(legacy), legacy).toHaveLength(0);
    }
  });

  it('init registers the settings, the menu and the runtime styles', () => {
    // Only this module's namespace: core's rtc settings belong to AVSettings.
    const moduleKeys = () =>
      [...env.settings.settings.keys()].filter((k) => k.startsWith('mediasoup-vtt.'));
    expect(moduleKeys()).toEqual([]);
    env.hooks.callAll('init');
    expect(moduleKeys().sort()).toEqual([
      'mediasoup-vtt.debugLogging',
      'mediasoup-vtt.mediaSoupAuthToken',
      'mediasoup-vtt.mediaSoupServerUrl',
    ]);
    expect([...env.settings.menus.keys()]).toEqual(['mediasoup-vtt.configDialog']);
    expect(document.getElementById('mediasoup-vtt-styles')?.textContent).toContain(
      '.mediasoup-settings-help',
    );
    // `once` hooks are gone after the first call.
    expect(env.hooks.handlers('init')).toHaveLength(0);
  });

  it('exposes the live AVMaster client as the MediaSoupVTT_Client debug alias', () => {
    const master = new AVMaster(new AVSettings());
    env.game.webrtc = master;
    expect((window as any).MediaSoupVTT_Client).toBe(master.client);
    expect((window as any).mediasoupClient?.version).toMatch(/^3\.24\./);
    env.game.webrtc = undefined;
  });

  it('warns at ready when core is not using MediaSoupAVClient, and not when it is', () => {
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    const ready = env.hooks.handlers('ready')[0]?.fn;
    expect(ready).toBeTypeOf('function');

    env.game.webrtc = { client: new SimplePeerAVClient({}, {}) };
    ready?.();
    expect(warn.mock.calls.some(([m]) => String(m).includes('SimplePeerAVClient'))).toBe(true);

    warn.mockClear();
    env.game.webrtc = new AVMaster(new AVSettings());
    ready?.();
    expect(warn).not.toHaveBeenCalled();
    env.game.webrtc = undefined;
  });
});

describe('v14 AVClient contract', () => {
  it('extends foundry.av.AVClient', () => {
    expect(MediaSoupAVClient.prototype).toBeInstanceOf(env.foundry.av.AVClient);
    expect(Object.getPrototypeOf(MediaSoupAVClient)).toBe(AVClient);
  });

  it.each(ABSTRACT)('overrides abstract %s() on its own prototype', (name) => {
    const own = Object.getOwnPropertyDescriptor(MediaSoupAVClient.prototype, name);
    expect(own, `${name} must be defined on MediaSoupAVClient.prototype`).toBeDefined();
    const method = own?.value as ((...a: unknown[]) => unknown) | undefined;
    expect(typeof method).toBe('function');
    expect(method).not.toBe((AVClient.prototype as any)[name]);
    // Accepts every documented parameter.
    expect(method?.length).toBeGreaterThanOrEqual(V14_AVCLIENT_ARITY[name]);
  });

  it('an instance built like core builds it answers every abstract member with the documented sync/async shape', async () => {
    // No server URL: connect() must fail cleanly, not reach the network.
    seedModuleSettings({ serverUrl: '', authToken: '' });
    const master = new AVMaster(new AVSettings());
    const client = master.client as MediaSoupAVClient;
    expect(client).toBeInstanceOf(MediaSoupAVClient);
    expect(client.master).toBe(master);
    expect(client.settings).toBe(master.settings);

    const video = document.createElement('video');
    const args: Record<(typeof ABSTRACT)[number], unknown[]> = {
      connect: [],
      disconnect: [],
      getConnectedUsers: [],
      getLevelsStreamForUser: [LOCAL_USER_ID],
      getMediaStreamForUser: [LOCAL_USER_ID],
      initialize: [],
      isAudioEnabled: [],
      isVideoEnabled: [],
      setUserVideo: [LOCAL_USER_ID, video],
      toggleAudio: [false],
      toggleBroadcast: [false],
      toggleVideo: [false],
      updateLocalStream: [],
    };
    for (const name of ABSTRACT) {
      const result = (client as any)[name](...args[name]);
      if (V14_AVCLIENT_ABSTRACT_MEMBERS[name] === 'async') {
        expect(result, `${name} returns a Promise`).toBeInstanceOf(Promise);
        await result; // a base-class "must be defined" error would reject here
      } else {
        expect(result, `${name} is synchronous`).not.toBeInstanceOf(Promise);
      }
    }
    expect(await client.connect()).toBe(false);
    expect(client.getConnectedUsers()).toEqual([LOCAL_USER_ID]);
    expect(env.notifications.warn).toHaveBeenCalledWith(
      expect.stringContaining('MediaSoup server URL not configured'),
      undefined,
    );
  });

  it('lists devices by kind from enumerateDevices (the non-abstract device members)', async () => {
    const client = new AVMaster(new AVSettings()).client as MediaSoupAVClient;
    expect(await client.getAudioSources()).toEqual({
      'mic-1': 'Desk Mic',
      'mic-2': 'Unknown device',
    });
    expect(await client.getVideoSources()).toEqual({ 'cam-1': 'Webcam' });
    expect(await client.getAudioSinks()).toEqual({ 'spk-1': 'Speakers' });
  });

  it('connects through AVMaster.connect() with the default transport core and sends media', async () => {
    const sfu = new FakeSfu({ token: TOKEN });
    const g = globalThis as any;
    const previousWebSocket = g.WebSocket;
    g.WebSocket = sfu.WebSocket;
    try {
      seedModuleSettings({ serverUrl: SERVER_URL, authToken: TOKEN });
      const master = new AVMaster(new AVSettings({ voiceMode: 'always' }));
      env.game.webrtc = master;
      expect(await master.connect()).toBe(true);
      await flush(20);

      const client = master.client as MediaSoupAVClient;
      expect(client.isConnected).toBe(true);
      expect(sfu.lastSocket.url).toBe(SERVER_URL);
      const produced = sfu.producersOf(LOCAL_USER_ID).map((p) => [p.kind, p.paused]);
      expect(produced.sort()).toEqual([
        ['audio', false],
        ['video', false],
      ]);

      expect(await master.disconnect()).toBe(true);
      expect(client.isConnected).toBe(false);
      expect(sfu.peers.size).toBe(0);
    } finally {
      g.WebSocket = previousWebSocket;
      env.game.webrtc = undefined;
    }
  });
});
