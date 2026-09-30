/**
 * Test fixtures for the SFU e2e specs: a "peer" is one Foundry user in its own
 * browser context, running the host page (a v14-shaped Foundry stub with the
 * real bundle) against an SFU.
 */

import {
  type Browser,
  type BrowserContext,
  test as base,
  expect,
  type Page,
} from '@playwright/test';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './sfu-server.js';

/** What `window.__e2e` (tests/e2e/sfu/host/foundry-stub.js) exposes. */
declare global {
  interface Window {
    __e2e: any;
    game: any;
    foundry: any;
    CONFIG: any;
    Hooks: any;
    MediaSoupVTT_Client: any;
    mediasoupClient: any;
  }
}

export type Kind = 'audio' | 'video';

export interface RemoteConsumer {
  consumerId: string;
  producerId: string;
  kind: Kind;
  closed: boolean;
  trackState: string;
  producerPaused: boolean;
}

export interface InboundCounters {
  consumerId: string;
  bytesReceived: number;
  packetsReceived: number;
  framesDecoded: number;
  frameWidth: number;
  /** Audio: energy of the decoded signal (grows only while it is not silence). */
  totalAudioEnergy: number;
  totalSamplesDuration: number;
}

/** A user's tile frame as luma (see `frame()` in the host stub). */
export interface Frame {
  mean: number;
  std: number;
  luma: number[];
  currentTime: number;
}

export interface Tile {
  present: boolean;
  hasStream?: boolean;
  /** srcObject is `client.getMediaStreamForUser(userId)`. */
  isClientStream?: boolean;
  /** srcObject is this page's own capture (`client.localStream`). */
  isLocalStream?: boolean;
  currentTime?: number;
  /** The camera view carries the `speaking` class. */
  speaking?: boolean;
  trackKinds?: string[];
  videoWidth?: number;
  videoHeight?: number;
  readyState?: number;
  paused?: boolean;
  muted?: boolean;
  audioPausedMarker?: boolean;
  videoPausedMarker?: boolean;
}

export interface Status {
  state: string;
  isConnected: boolean;
  connectedUsers: string[];
  remoteUsers: string[];
  producers: Array<{ tag: string; paused: boolean }>;
  audioEnabled: boolean;
  videoEnabled: boolean;
  /** AVMaster#broadcasting. */
  broadcasting: boolean;
  /** The local capture's tracks as `kind:enabled|disabled`. */
  localTracks: string[];
  /** How many times CameraViews rendered. */
  renders: number;
}

export interface PeerOptions {
  user: string;
  /** Every user of the world (all active); defaults to just `user`. */
  users?: string[];
  /** Server URL; defaults to the shared SFU from global setup. */
  sfuUrl?: string;
  /** Auth token; defaults to the shared SFU's token. */
  token?: string;
  voice?: 'always' | 'activity' | 'ptt';
}

export class Peer {
  readonly logs: string[] = [];

  constructor(
    readonly user: string,
    readonly context: BrowserContext,
    readonly page: Page,
  ) {
    page.on('console', (msg) => this.logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (error) => this.logs.push(`[pageerror] ${error.stack ?? error}`));
  }

  connect(): Promise<boolean> {
    return this.page.evaluate(() => window.__e2e.connect());
  }

  status(): Promise<Status> {
    return this.page.evaluate(() => window.__e2e.status());
  }

  remoteConsumers(from: string): Promise<RemoteConsumer[]> {
    return this.page.evaluate((id) => window.__e2e.remoteConsumers(id), from);
  }

  async consumersOfKind(from: string, kind: Kind): Promise<RemoteConsumer[]> {
    return (await this.remoteConsumers(from)).filter((c) => c.kind === kind);
  }

  inbound(from: string): Promise<Partial<Record<Kind, InboundCounters>>> {
    return this.page.evaluate((id) => window.__e2e.inbound(id), from);
  }

  outbound(): Promise<Record<string, { bytesSent: number; packetsSent: number; paused: boolean }>> {
    return this.page.evaluate(() => window.__e2e.outbound());
  }

  /**
   * Read a user's dock tile as it is. This never renders: the tile only
   * changes when the client (or core) re-renders CameraViews by itself.
   */
  tile(userId: string): Promise<Tile> {
    return this.page.evaluate((id) => window.__e2e.tile(id), userId);
  }

  /** The current frame of a user's tile, or null while it shows no video. */
  frame(userId: string): Promise<Frame | null> {
    return this.page.evaluate((id) => window.__e2e.frame(id), userId);
  }

  /** Every time the host's voice-detection double was armed (start) or disarmed (stop). */
  levelReports(): Promise<
    Array<{ op: 'start' | 'stop'; id: string; audioTracks?: number; enabledAudioTracks?: number }>
  > {
    return this.page.evaluate(() => window.__e2e.levelReports);
  }

  /** The `{av: ...}` activity this user broadcast to the others. */
  activity(): Promise<Array<{ av?: { muted?: boolean; hidden?: boolean; speaking?: boolean } }>> {
    return this.page.evaluate(() => window.__e2e.activity);
  }

  notifications(): Promise<Array<{ level: string; message: string }>> {
    return this.page.evaluate(() => window.__e2e.notifications);
  }

  transportStates(): Promise<string[]> {
    return this.page.evaluate(() =>
      window.__e2e.transportStates.map((s: { state: string }) => s.state),
    );
  }

  /** Change an A/V client setting through AVSettings#set (applied after a short debounce). */
  setClientSetting(key: string, value: unknown): Promise<void> {
    return this.page.evaluate(([k, v]) => window.__e2e.setClientSetting(k, v), [
      key,
      value,
    ] as const);
  }

  /** Wait until this peer holds exactly one live consumer per kind from `from`. */
  async expectConsuming(from: string, kinds: Kind[] = ['audio', 'video']): Promise<void> {
    await expect
      .poll(
        async () =>
          (await this.remoteConsumers(from))
            .filter((c) => !c.closed && c.trackState === 'live')
            .map((c) => c.kind)
            .sort(),
        { message: `${this.user} consumes ${kinds.join('+')} from ${from}`, timeout: 20_000 },
      )
      .toEqual([...kinds].sort());
  }

  /**
   * Prove media flows from `from` to this peer: inbound-rtp bytes and packets
   * grow between two samples of the same consumer, and video frames decode.
   */
  async expectReceiving(from: string, kinds: Kind[] = ['audio', 'video']): Promise<void> {
    if (kinds.includes('video')) {
      await expect
        .poll(async () => (await this.inbound(from)).video?.framesDecoded ?? 0, {
          message: `${this.user} decodes video frames from ${from}`,
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
    }
    for (const kind of kinds) {
      await expect
        .poll(async () => (await this.inbound(from))[kind]?.packetsReceived ?? 0, {
          message: `${this.user} receives ${kind} packets from ${from}`,
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
    }
    const first = await this.inbound(from);
    await this.page.waitForTimeout(1_500);
    const second = await this.inbound(from);
    for (const kind of kinds) {
      const a = first[kind];
      const b = second[kind];
      expect(a, `${kind} stats from ${from} (first sample)`).toBeDefined();
      expect(b, `${kind} stats from ${from} (second sample)`).toBeDefined();
      if (!a || !b) continue;
      expect(b.consumerId, `${kind} consumer unchanged between samples`).toBe(a.consumerId);
      expect(b.bytesReceived, `${kind} bytesReceived grows`).toBeGreaterThan(a.bytesReceived);
      expect(b.packetsReceived, `${kind} packetsReceived grows`).toBeGreaterThan(a.packetsReceived);
      if (kind === 'video') {
        expect(b.framesDecoded, 'video framesDecoded grows').toBeGreaterThan(a.framesDecoded);
      } else {
        // Silence (a disabled microphone track) arrives at the same packet
        // rate; Chromium's fake microphone beeps, so real audio adds energy.
        expect(b.totalAudioEnergy, 'audio energy grows (not silence)').toBeGreaterThan(
          a.totalAudioEnergy,
        );
      }
    }
    if (kinds.includes('video')) await this.expectVideoContent(from);
  }

  /** Audio from `from` stops: neither packets nor energy grow between two samples. */
  async expectAudioStalled(from: string): Promise<void> {
    // Let packets already in flight land first.
    await this.page.waitForTimeout(1_000);
    const first = (await this.inbound(from)).audio;
    await this.page.waitForTimeout(1_500);
    const second = (await this.inbound(from)).audio;
    expect(second?.consumerId, `audio consumer from ${from} unchanged`).toBe(first?.consumerId);
    expect(second?.packetsReceived, `no audio packets from ${from}`).toBe(first?.packetsReceived);
    expect(second?.totalAudioEnergy, `no audio energy from ${from}`).toBe(first?.totalAudioEnergy);
  }

  /** Wait until audio from `from` is audible again: packets and energy grow. */
  async expectAudioResumed(from: string, since: InboundCounters | undefined): Promise<void> {
    await expect
      .poll(async () => (await this.inbound(from)).audio?.totalAudioEnergy ?? 0, {
        message: `${this.user} hears ${from} again (audio energy grows)`,
        timeout: 10_000,
      })
      .toBeGreaterThan(since?.totalAudioEnergy ?? 0);
    expect((await this.inbound(from)).audio?.packetsReceived ?? 0).toBeGreaterThan(
      since?.packetsReceived ?? 0,
    );
  }

  /**
   * The tile shows real camera pictures: not a uniform (black) frame, and
   * the picture changes over time. Chromium's fake camera draws a moving
   * pattern; a disabled video track sends black frames that still decode.
   */
  async expectVideoContent(userId: string): Promise<void> {
    await expect
      .poll(async () => (await this.frame(userId))?.std ?? 0, {
        message: `${this.user}: ${userId}'s tile shows a non-uniform picture (luma std-dev)`,
        timeout: 15_000,
      })
      .toBeGreaterThan(8);
    const first = await this.frame(userId);
    await this.page.waitForTimeout(1_000);
    const second = await this.frame(userId);
    expect(first, `${userId}'s tile has a frame`).not.toBeNull();
    expect(second, `${userId}'s tile still has a frame`).not.toBeNull();
    if (!first || !second) return;
    const diff =
      first.luma.reduce((acc, y, i) => acc + Math.abs(y - (second.luma[i] ?? 0)), 0) /
      first.luma.length;
    expect(diff, `${userId}'s picture changes between frames (mean |Δluma|)`).toBeGreaterThan(0.5);
    expect(second.std, `${userId}'s later frame is not uniform`).toBeGreaterThan(8);
  }

  /**
   * The user's dock tile, as the client left it (no forced render), plays
   * that user's remote stream: the client's stream for the user, not the
   * local capture, with real dimensions, playing, its clock advancing and a
   * real (non-black, moving) picture.
   */
  async expectVideoTile(userId: string): Promise<void> {
    await expect
      .poll(
        async () => {
          const t = await this.tile(userId);
          return t.isClientStream === true && (t.videoWidth ?? 0) > 0;
        },
        {
          message: `${this.user} shows ${userId}'s stream with videoWidth > 0 (without a forced render)`,
          timeout: 20_000,
        },
      )
      .toBe(true);
    const first = await this.tile(userId);
    expect(first.isLocalStream, `${userId}'s tile is not the local capture`).toBe(false);
    expect(first.videoHeight ?? 0, `${userId}'s tile videoHeight`).toBeGreaterThan(0);
    expect(first.readyState ?? 0, `${userId}'s tile has current data`).toBeGreaterThanOrEqual(2);
    expect(first.paused, `${userId}'s tile is playing`).toBe(false);
    await this.page.waitForTimeout(1_000);
    const second = await this.tile(userId);
    expect(second.currentTime ?? 0, `${userId}'s playback advances`).toBeGreaterThan(
      first.currentTime ?? 0,
    );
    await this.expectVideoContent(userId);
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

export interface PeerFactory {
  (options: PeerOptions): Promise<Peer>;
  /** The world (and so SFU room) id shared by the peers of this test. */
  readonly world: string;
}

async function openPeer(browser: Browser, world: string, options: PeerOptions): Promise<Peer> {
  const baseUrl = process.env.E2E_BASE_URL;
  if (!baseUrl) throw new Error('E2E_BASE_URL is not set; is the global setup running?');
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  const peer = new Peer(options.user, context, page);
  const query = new URLSearchParams({
    user: options.user,
    users: (options.users ?? [options.user]).join(','),
    world,
    sfu: options.sfuUrl ?? process.env.E2E_SFU_URL ?? '',
    token: options.token ?? process.env.E2E_SFU_TOKEN ?? '',
    voice: options.voice ?? 'always',
  });
  await page.goto(`${baseUrl}/?${query}`);
  await page.waitForFunction(() => window.__e2e?.ready || window.__e2e?.bootError);
  const bootError = await page.evaluate(() => window.__e2e.bootError);
  if (bootError) throw new Error(`Host page boot failed for ${options.user}: ${bootError}`);
  return peer;
}

export const test = base.extend<{ peers: PeerFactory }>({
  peers: async ({ browser }, use, testInfo) => {
    const opened: Peer[] = [];
    // One SFU room per test (MediaSoupAVClient uses game.world.id as roomId).
    const world = `w-${testInfo.testId}-r${testInfo.retry}`;
    const factory = Object.assign(
      async (options: PeerOptions) => {
        const peer = await openPeer(browser, world, options);
        opened.push(peer);
        return peer;
      },
      { world },
    );
    await use(factory);
    if (testInfo.status !== testInfo.expectedStatus) {
      // Attached to the report, and kept under test-results/e2e-logs/ (which
      // Playwright does not wipe between runs) next to the SFU logs.
      mkdirSync(LOG_DIR, { recursive: true });
      const slug = testInfo.titlePath
        .slice(1)
        .join(' ')
        .replace(/[^a-z0-9]+/gi, '-');
      for (const peer of opened) {
        const body = peer.logs.join('\n');
        await testInfo.attach(`console-${peer.user}.log`, { body, contentType: 'text/plain' });
        appendFileSync(
          path.join(LOG_DIR, `failed-${slug}-r${testInfo.retry}-${peer.user}.log`),
          `=== ${new Date().toISOString()} ===\n${body}\n`,
        );
      }
    }
    for (const peer of opened) await peer.close().catch(() => {});
  },
});

export { expect };
