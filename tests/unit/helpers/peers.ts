/**
 * Builders for transport cores and AV clients wired to a {@link FakeSfu}.
 */

import { vi } from 'vitest';
import { MediaSoupAVClient } from '../../../src/client/MediaSoupAVClient';
import {
  MediaSoupVTTClient,
  type MediaSoupVTTClientOptions,
} from '../../../src/client/MediaSoupVTTClient';
import type { FakeSfu } from './fake-ws';
import {
  AVMaster,
  type AVMasterOptions,
  AVSettings,
  type AVClientSettingsInit,
  foundryEnv,
  LOCAL_USER_ID,
  seedModuleSettings,
  WORLD_ID,
} from './foundry-v14';
import { fakeDeviceFactory } from './media';

export const SERVER_URL = 'ws://sfu.test:4443';
export const TOKEN = 'secret';

/** Settle pending timers and microtasks (fake-SFU replies use setTimeout(0)). */
export function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `predicate` holds (real timers). */
export async function until(predicate: () => boolean, timeout = 1000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error('condition not met yet');
    },
    { timeout, interval: 2 },
  );
}

export interface CoreOptions extends MediaSoupVTTClientOptions {
  sfu: FakeSfu;
}

/** A transport core on the fake SFU, with fast recovery timings. */
export function createCore({ sfu, ...options }: CoreOptions) {
  const device = fakeDeviceFactory();
  const core = new MediaSoupVTTClient({
    serverUrl: SERVER_URL,
    authToken: TOKEN,
    userId: LOCAL_USER_ID,
    roomId: WORLD_ID,
    WebSocketImpl: sfu.WebSocket,
    deviceFactory: device.factory,
    reconnect: { baseDelayMs: 10, maxDelayMs: 40, maxAttempts: 3 },
    ice: { disconnectedGraceMs: 15, maxRestarts: 2 },
    random: () => 0.5,
    ...options,
  });
  return { core, handlers: device.handlers, devices: device.devices };
}

export interface AVClientHarnessOptions {
  sfu: FakeSfu;
  settings?: AVClientSettingsInit & { mode?: number };
  master?: AVMasterOptions;
  core?: Partial<MediaSoupVTTClientOptions>;
  serverUrl?: string;
  authToken?: string;
}

/**
 * An AVMaster + MediaSoupAVClient pair the way core builds them
 * (`new CONFIG.WebRTC.clientClass(master, settings)`), except that the
 * transport core is injected so it talks to the fake SFU.
 */
export function createAVClient(options: AVClientHarnessOptions) {
  seedModuleSettings({
    serverUrl: options.serverUrl ?? SERVER_URL,
    authToken: options.authToken ?? TOKEN,
  });
  const env = foundryEnv();
  const { core, handlers } = createCore({ sfu: options.sfu, ...options.core });
  const settings = new AVSettings(options.settings);
  const previous = env.CONFIG.WebRTC.clientClass;
  // AVMaster constructs CONFIG.WebRTC.clientClass(master, settings); pass the
  // fake-SFU core as the optional third argument.
  env.CONFIG.WebRTC.clientClass = class extends MediaSoupAVClient {
    constructor(master: AVMaster, avSettings: AVSettings) {
      super(master as any, avSettings as any, core);
    }
  };
  let master: AVMaster;
  try {
    master = new AVMaster(settings, options.master);
  } finally {
    env.CONFIG.WebRTC.clientClass = previous;
  }
  env.game.webrtc = master;
  const client = master.client as MediaSoupAVClient;
  return { master, client, core, settings, handlers, env };
}
