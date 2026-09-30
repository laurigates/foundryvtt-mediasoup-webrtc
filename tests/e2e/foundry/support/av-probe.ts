/**
 * Read A/V state out of a live Foundry page: the MediaSoupAVClient that core
 * AVMaster owns (`game.webrtc.client`), the camera dock core renders
 * (`ui.webrtc`, CameraViews) and the WebRTC stats of the SFU consumers.
 *
 * Nothing here drives media itself: core connects the client (AVMaster ->
 * initialize() + connect()) and core renders the dock (CameraViews ->
 * client.setUserVideo()). The probes only observe, so a passing spec means
 * the module works under real Foundry, not under test scaffolding.
 */

import { expect, type Page } from '@playwright/test';

export type Kind = 'audio' | 'video';

export interface ClientStatus {
  clientClass: string;
  isConnected: boolean;
  transportState: string | null;
  connectedUsers: string[];
  remoteUsers: string[];
  audioEnabled: boolean;
  videoEnabled: boolean;
  producers: Array<{ tag: string; kind: string; paused: boolean }>;
}

export interface Tile {
  present: boolean;
  /** The element's srcObject is the stream the client holds for that user. */
  isClientStream: boolean;
  /** ...and not this page's own local capture. */
  isLocalStream: boolean;
  trackKinds: string[];
  videoWidth: number;
  videoHeight: number;
  readyState: number;
  paused: boolean;
  muted: boolean;
  /** Core renders `<video hidden>` when it thinks the user shares no video. */
  hidden: boolean;
  currentTime: number;
}

export interface InboundCounters {
  consumerId: string;
  bytesReceived: number;
  packetsReceived: number;
  framesDecoded: number;
  /** Audio: energy of the decoded signal (a disabled mic sends silence packets). */
  totalAudioEnergy: number;
}

/** A tile's current picture as luma on a 64x48 canvas. */
export interface Frame {
  mean: number;
  std: number;
  luma: number[];
}

export function clientStatus(page: Page): Promise<ClientStatus> {
  return page.evaluate(() => {
    const g = globalThis as any;
    const client = g.game?.webrtc?.client;
    const transport = client?.transport;
    return {
      clientClass: client?.constructor?.name ?? 'none',
      isConnected: client?.isConnected === true,
      transportState: transport?.state ?? null,
      connectedUsers: client?.getConnectedUsers?.() ?? [],
      remoteUsers: transport?.getRemoteUserIds?.() ?? [],
      audioEnabled: client?.isAudioEnabled?.() === true,
      videoEnabled: client?.isVideoEnabled?.() === true,
      producers: transport
        ? [...transport.producers.entries()].map(([tag, p]: [string, any]) => ({
            tag,
            kind: p.kind,
            paused: p.paused,
          }))
        : [],
    };
  });
}

export async function expectConnected(page: Page, who: string): Promise<void> {
  await expect
    .poll(async () => (await clientStatus(page)).isConnected, {
      message: `${who}: game.webrtc.client connects to the SFU`,
      timeout: 60_000,
    })
    .toBe(true);
}

/**
 * Switch this client's voice mode to "always" through core AVSettings, so the
 * microphone producer is not held paused by push-to-talk or voice activation.
 */
export function setVoiceAlways(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const g = globalThis as any;
    await g.game.webrtc.settings.set('client', 'voice.mode', 'always');
  });
}

/**
 * Read the user's camera tile as core rendered it. With `render: true` the
 * dock is re-rendered first; by default it is read as it is, so the client
 * (or core) must have re-rendered it by itself.
 */
export async function readTile(
  page: Page,
  userId: string,
  { render = false }: { render?: boolean } = {},
): Promise<Tile> {
  if (render) {
    await page.evaluate(() => (globalThis as any).ui?.webrtc?.render?.());
    // CameraViews renders asynchronously; give it a frame.
    await page.waitForTimeout(250);
  }
  return page.evaluate((id) => {
    const g = globalThis as any;
    const views = g.ui?.webrtc;
    const video: HTMLVideoElement | null =
      views?.getUserVideoElement?.(id) ??
      document.querySelector(`.camera-view[data-user="${id}"] video, [data-user="${id}"] video`);
    const empty = {
      present: false,
      isClientStream: false,
      isLocalStream: false,
      trackKinds: [] as string[],
      videoWidth: 0,
      videoHeight: 0,
      readyState: 0,
      paused: true,
      muted: false,
      hidden: true,
      currentTime: 0,
    };
    if (!video) return empty;
    const client = g.game?.webrtc?.client;
    const stream = video.srcObject as MediaStream | null;
    return {
      present: true,
      isClientStream: !!stream && stream === client?.getMediaStreamForUser?.(id),
      isLocalStream: !!stream && stream === client?.localStream,
      trackKinds: stream
        ? stream
            .getTracks()
            .map((t) => `${t.kind}:${t.readyState}`)
            .sort()
        : [],
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      readyState: video.readyState,
      paused: video.paused,
      muted: video.muted,
      hidden: video.hidden === true,
      currentTime: video.currentTime,
    };
  }, userId);
}

/** inbound-rtp counters, per kind, of this page's SFU consumers of `userId`'s producers. */
export function inbound(
  page: Page,
  userId: string,
): Promise<Partial<Record<Kind, InboundCounters>>> {
  return page.evaluate(async (id) => {
    const g = globalThis as any;
    const transport = g.game?.webrtc?.client?.transport;
    const out: Record<string, InboundCounters> = {};
    if (!transport) return out;
    for (const [consumerId, consumer] of transport.consumers as Map<string, any>) {
      if (transport.consumerToUserMap.get(consumerId) !== id || consumer.closed) continue;
      const report: RTCStatsReport = await consumer.getStats();
      report.forEach((stat: any) => {
        if (stat.type !== 'inbound-rtp') return;
        out[consumer.kind] = {
          consumerId,
          bytesReceived: stat.bytesReceived ?? 0,
          packetsReceived: stat.packetsReceived ?? 0,
          framesDecoded: stat.framesDecoded ?? 0,
          totalAudioEnergy: stat.totalAudioEnergy ?? 0,
        };
      });
    }
    return out;
  }, userId);
}

/** The current picture of `userId`'s tile, or null while it shows no video. */
export function readFrame(page: Page, userId: string): Promise<Frame | null> {
  return page.evaluate((id) => {
    const g = globalThis as any;
    const video: HTMLVideoElement | null = g.ui?.webrtc?.getUserVideoElement?.(id) ?? null;
    if (!video?.videoWidth || video.readyState < 2) return null;
    const w = 64;
    const h = 48;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const luma: number[] = [];
    let sum = 0;
    for (let i = 0; i < w * h; i++) {
      const y =
        0.299 * (data[4 * i] ?? 0) +
        0.587 * (data[4 * i + 1] ?? 0) +
        0.114 * (data[4 * i + 2] ?? 0);
      luma.push(Math.round(y));
      sum += y;
    }
    const mean = sum / luma.length;
    const variance = luma.reduce((acc, y) => acc + (y - mean) ** 2, 0) / luma.length;
    return { mean, std: Math.sqrt(variance), luma };
  }, userId);
}

/**
 * The tile shows real camera pictures: not uniform (a disabled video track
 * sends black frames that still decode) and changing over time (Chromium's
 * fake camera draws a moving pattern).
 */
export async function expectVideoContent(page: Page, userId: string, who: string): Promise<void> {
  await expect
    .poll(async () => (await readFrame(page, userId))?.std ?? 0, {
      message: `${who}: ${userId}'s tile shows a non-uniform picture (luma std-dev)`,
      timeout: 20_000,
    })
    .toBeGreaterThan(8);
  const first = await readFrame(page, userId);
  await page.waitForTimeout(1_000);
  const second = await readFrame(page, userId);
  expect(first, `${who}: ${userId}'s tile has a frame`).not.toBeNull();
  expect(second, `${who}: ${userId}'s tile still has a frame`).not.toBeNull();
  if (!first || !second) return;
  const diff =
    first.luma.reduce((acc, y, i) => acc + Math.abs(y - (second.luma[i] ?? 0)), 0) /
    first.luma.length;
  expect(diff, `${who}: ${userId}'s picture changes between frames`).toBeGreaterThan(0.5);
}

/** Live consumers, per kind, this page holds for `userId`'s producers. */
export function consumerKinds(page: Page, userId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const g = globalThis as any;
    const transport = g.game?.webrtc?.client?.transport;
    if (!transport) return [];
    return [...(transport.consumers as Map<string, any>).entries()]
      .filter(([cid, c]) => transport.consumerToUserMap.get(cid) === id && !c.closed)
      .map(([, c]) => `${c.kind}:${c.track?.readyState}`)
      .sort();
  }, userId);
}

/**
 * The dock tile for `userId` plays that user's remote stream: the element's
 * srcObject is the client's stream for the user (not the local capture), it
 * holds a live audio and a live video track, it is not muted, it has real
 * dimensions, its playback clock advances and it shows a real picture. The
 * dock is read as core and the client left it: nothing forces a render.
 */
export async function expectPlayingRemoteTile(
  page: Page,
  userId: string,
  who: string,
): Promise<void> {
  await expect
    .poll(async () => (await readTile(page, userId)).videoWidth, {
      message: `${who}: the camera tile of ${userId} shows decoded video (videoWidth > 0)`,
      timeout: 45_000,
    })
    .toBeGreaterThan(0);

  const first = await readTile(page, userId);
  expect(first.present, `${who}: CameraViews renders a <video> for ${userId}`).toBe(true);
  expect(first.isClientStream, `${who}: the <video> plays the client's stream for ${userId}`).toBe(
    true,
  );
  expect(first.isLocalStream, `${who}: the <video> is not the local capture`).toBe(false);
  expect(first.trackKinds, `${who}: live remote audio + video tracks`).toEqual([
    'audio:live',
    'video:live',
  ]);
  expect(first.videoHeight, `${who}: videoHeight > 0`).toBeGreaterThan(0);
  expect(first.readyState, `${who}: HAVE_CURRENT_DATA or better`).toBeGreaterThanOrEqual(2);
  expect(first.paused, `${who}: the <video> is playing`).toBe(false);
  expect(first.muted, `${who}: remote audio is not muted`).toBe(false);
  expect(first.hidden, `${who}: core shows the tile's video (the user shares video)`).toBe(false);

  await page.waitForTimeout(1_500);
  const second = await readTile(page, userId);
  expect(second.currentTime, `${who}: playback of ${userId}'s video advances`).toBeGreaterThan(
    first.currentTime,
  );
  await expectVideoContent(page, userId, who);
}

/**
 * Media really flows: inbound-rtp bytes and packets of the same consumers
 * grow between two samples, for audio and video, and video frames decode.
 */
export async function expectReceiving(page: Page, userId: string, who: string): Promise<void> {
  for (const kind of ['audio', 'video'] as const) {
    await expect
      .poll(async () => (await inbound(page, userId))[kind]?.packetsReceived ?? 0, {
        message: `${who}: receives ${kind} RTP from ${userId}`,
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
  }
  const a = await inbound(page, userId);
  await page.waitForTimeout(2_000);
  const b = await inbound(page, userId);
  for (const kind of ['audio', 'video'] as const) {
    const first = a[kind];
    const second = b[kind];
    expect(first, `${who}: ${kind} inbound stats (first sample)`).toBeDefined();
    expect(second, `${who}: ${kind} inbound stats (second sample)`).toBeDefined();
    if (!first || !second) continue;
    expect(second.consumerId, `${who}: same ${kind} consumer in both samples`).toBe(
      first.consumerId,
    );
    expect(second.bytesReceived, `${who}: ${kind} bytesReceived grows`).toBeGreaterThan(
      first.bytesReceived,
    );
    expect(second.packetsReceived, `${who}: ${kind} packetsReceived grows`).toBeGreaterThan(
      first.packetsReceived,
    );
    if (kind === 'video') {
      expect(second.framesDecoded, `${who}: video framesDecoded grows`).toBeGreaterThan(
        first.framesDecoded,
      );
    } else {
      // Chromium's fake microphone beeps; silence would add no energy.
      expect(second.totalAudioEnergy, `${who}: audio energy grows (not silence)`).toBeGreaterThan(
        first.totalAudioEnergy,
      );
    }
  }
}
