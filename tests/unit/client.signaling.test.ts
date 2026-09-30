/**
 * The transport core (MediaSoupVTTClient) against the fake SFU: the wire
 * payloads, the join sequence, media flowing between two peers, late join,
 * dedupe, and producer/consumer teardown.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  type RemoteTrackInfo,
  SignalingError,
} from '../../src/client/MediaSoupVTTClient';
import { FakeSfu } from './helpers/fake-ws';
import { LOCAL_USER_ID, REMOTE_USER_ID, WORLD_ID } from './helpers/foundry-v14';
import { audioTrack, videoTrack } from './helpers/media';
import { createCore, flush, TOKEN, until } from './helpers/peers';

let sfu: FakeSfu;

beforeEach(() => {
  sfu = new FakeSfu({ token: TOKEN });
});

/** Connect a second peer (the remote user) and record what it receives. */
async function connectRemote(userId = REMOTE_USER_ID) {
  const { core } = createCore({ sfu, userId });
  const added: RemoteTrackInfo[] = [];
  const removed: RemoteTrackInfo[] = [];
  const updated: RemoteTrackInfo[] = [];
  core.on('consumerAdded', (i) => added.push(i));
  core.on('consumerRemoved', (i) => removed.push(i));
  core.on('consumerUpdated', (i) => updated.push({ ...i }));
  await core.connect();
  return { core, added, removed, updated, socket: sfu.lastSocket };
}

describe('signaling payloads', () => {
  it('opens with authenticate carrying token, roomId, userId and the session id', async () => {
    const { core } = createCore({ sfu });
    await core.connect();
    const first = sfu.lastSocket.sent[0];
    expect(first).toMatchObject({
      type: 'authenticate',
      token: TOKEN,
      roomId: WORLD_ID,
      userId: LOCAL_USER_ID,
      sessionId: core.sessionId,
      reconnect: false,
    });
    expect(typeof first?.requestId).toBe('string');
    core.disconnect();
  });

  it('joins in contract order: auth, router caps, send transport, recv transport, getProducers', async () => {
    const { core } = createCore({ sfu });
    await core.connect();
    await flush();
    const sent = sfu.lastSocket.sent;
    expect(sent.map((m) => m.type)).toEqual([
      'authenticate',
      'getRouterRtpCapabilities',
      'createWebRtcTransport',
      'createWebRtcTransport',
      'getProducers',
    ]);
    expect(sent[2]).toMatchObject({ producing: true, consuming: false, forceTcp: false });
    expect(sent[3]).toMatchObject({ producing: false, consuming: true });
    expect(core.isConnected).toBe(true);
    expect(core.state).toBe('connected');
    core.disconnect();
  });

  it('never sends sctpCapabilities (the SFU opens no data channels)', async () => {
    const { core } = createCore({ sfu });
    await core.connect();
    await core.startLocalAudio(audioTrack());
    const remote = await connectRemote();
    await until(() => remote.added.length === 1);
    const frames = [...sfu.sockets.flatMap((s) => s.sent)];
    expect(frames.length).toBeGreaterThan(10);
    for (const frame of frames) expect(JSON.stringify(frame)).not.toContain('sctpCapabilities');
    core.disconnect();
    remote.core.disconnect();
  });

  it('produce connects the send transport with DTLS parameters, then sends kind, rtpParameters and paused', async () => {
    const { core } = createCore({ sfu });
    await core.connect();
    const producer = await core.startLocalAudio(audioTrack());
    const socket = sfu.lastSocket;
    const [connect] = socket.requests('connectTransport');
    expect(connect).toMatchObject({ transportId: core.sendTransport?.id });
    expect(connect?.dtlsParameters?.fingerprints?.length).toBeGreaterThan(0);
    const [produce] = socket.requests('produce');
    expect(produce).toMatchObject({
      transportId: core.sendTransport?.id,
      kind: 'audio',
      paused: false,
      appData: { mediaTag: 'mic', userId: LOCAL_USER_ID },
    });
    expect(produce?.rtpParameters?.codecs?.length).toBeGreaterThan(0);
    expect(producer?.id).toBe(sfu.producersOf(LOCAL_USER_ID)[0]?.id);
    core.disconnect();
  });

  it('a track produced paused is born paused on the server, with no pauseProducer follow-up', async () => {
    const { core } = createCore({ sfu });
    await core.connect();
    const producer = await core.startLocalAudio(audioTrack(), { paused: true });
    await flush();
    expect(producer?.paused).toBe(true);
    expect(sfu.producersOf(LOCAL_USER_ID)[0]?.paused).toBe(true);
    expect(sfu.lastSocket.requests('pauseProducer')).toHaveLength(0);
    core.disconnect();
  });

  it('pause/resume send one pauseProducer/resumeProducer each with the producer id', async () => {
    const { core } = createCore({ sfu });
    await core.connect();
    const producer = await core.startLocalVideo(videoTrack());
    expect(core.pauseProducer('webcam')).toBe(true);
    expect(core.pauseProducer('webcam')).toBe(false); // already paused: no second request
    await flush();
    expect(sfu.lastSocket.requests('pauseProducer')).toEqual([
      expect.objectContaining({ producerId: producer?.id }),
    ]);
    expect(sfu.producersOf(LOCAL_USER_ID)[0]?.paused).toBe(true);
    expect(core.resumeProducer('webcam')).toBe(true);
    await flush();
    expect(sfu.lastSocket.requests('resumeProducer')).toEqual([
      expect.objectContaining({ producerId: producer?.id }),
    ]);
    expect(sfu.producersOf(LOCAL_USER_ID)[0]?.paused).toBe(false);
    core.disconnect();
  });

  it('consume sends the recv transport id and the device recvRtpCapabilities, then consumerResume', async () => {
    const { core } = createCore({ sfu });
    await core.connect();
    await core.startLocalAudio(audioTrack());
    const remote = await connectRemote();
    await until(() => remote.added.length === 1);
    const [consume] = remote.socket.requests('consume');
    expect(consume).toMatchObject({
      transportId: remote.core.recvTransport?.id,
      producerId: sfu.producersOf(LOCAL_USER_ID)[0]?.id,
    });
    expect(consume?.rtpCapabilities).toEqual(
      JSON.parse(JSON.stringify(remote.core.device?.recvRtpCapabilities)),
    );
    expect(consume?.rtpCapabilities.codecs.length).toBeGreaterThan(0);
    expect(remote.socket.requests('consumerResume')).toEqual([
      expect.objectContaining({ consumerId: remote.added[0]?.consumerId }),
    ]);
    core.disconnect();
    remote.core.disconnect();
  });

  it('rejects authenticate failures with AuthenticationError and ends in state failed', async () => {
    const { core } = createCore({ sfu, authToken: 'wrong' });
    const error = await core.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(String((error as Error).message)).toContain('Invalid authentication token');
    expect(core.state).toBe('failed');
    expect(core.isConnected).toBe(false);
  });

  it('maps error replies to SignalingError(server) and silence to SignalingError(timeout)', async () => {
    const { core } = createCore({ sfu, requestTimeoutMs: 30 });
    await core.connect();
    const unknown = await core.request('noSuchMethod').catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(SignalingError);
    expect(unknown).toMatchObject({ failure: 'server', requestType: 'noSuchMethod' });
    sfu.override({ type: 'getProducers', hang: true });
    const timeout = await core.request('getProducers').catch((e: unknown) => e);
    expect(timeout).toMatchObject({ failure: 'timeout', requestType: 'getProducers' });
    expect(core.requestMap.size).toBe(0);
    core.disconnect();
  });
});

describe('media between two peers through the SFU', () => {
  it('A produces audio and video; B consumes both as tracks of user A', async () => {
    const a = createCore({ sfu });
    await a.core.connect();
    const mic = audioTrack();
    const cam = videoTrack();
    await a.core.startLocalAudio(mic);
    await a.core.startLocalVideo(cam);

    const b = await connectRemote();
    await until(() => b.added.length === 2);
    expect(b.added.map((i) => [i.userId, i.kind, i.producerPaused]).sort()).toEqual([
      [LOCAL_USER_ID, 'audio', false],
      [LOCAL_USER_ID, 'video', false],
    ]);
    const tracks = b.core.getRemoteTracks(LOCAL_USER_ID);
    expect(tracks.audio?.kind).toBe('audio');
    expect(tracks.video?.kind).toBe('video');
    expect(tracks.audio?.readyState).toBe('live');
    expect(b.core.getRemoteUserIds()).toEqual([LOCAL_USER_ID]);
    // B's consumers map back to A's producers.
    const producerIds = sfu
      .producersOf(LOCAL_USER_ID)
      .map((p) => p.id)
      .sort();
    expect(b.added.map((i) => i.producerId).sort()).toEqual(producerIds);
    a.core.disconnect();
    b.core.disconnect();
  });

  it('a late joiner consumes existing producers via getProducers, including their paused state', async () => {
    const a = createCore({ sfu });
    await a.core.connect();
    await a.core.startLocalAudio(audioTrack(), { paused: true });
    await a.core.startLocalVideo(videoTrack());

    const b = await connectRemote();
    await until(() => b.added.length === 2);
    expect(b.socket.requests('getProducers')).toHaveLength(1);
    expect(b.socket.received.some((m) => m.type === 'newProducer')).toBe(false);
    const info = b.core.getRemoteTrackInfo(LOCAL_USER_ID);
    expect(info.audio?.producerPaused).toBe(true);
    expect(info.video?.producerPaused).toBe(false);
    a.core.disconnect();
    b.core.disconnect();
  });

  it('a newProducer racing the getProducers reply is consumed exactly once', async () => {
    const a = createCore({ sfu });
    await a.core.connect();
    await a.core.startLocalAudio(audioTrack());
    const [producer] = sfu.producersOf(LOCAL_USER_ID);
    // The announcement reaches B just before the getProducers reply that also lists it.
    sfu.override({
      type: 'getProducers',
      before: (socket) =>
        sfu.deliver(socket, {
          type: 'newProducer',
          producerId: producer?.id,
          userId: LOCAL_USER_ID,
          kind: 'audio',
          paused: false,
        }),
    });
    const b = await connectRemote();
    await until(() => b.added.length === 1);
    await flush(20);
    expect(b.socket.received.filter((m) => m.type === 'newProducer')).toHaveLength(1);
    expect(b.socket.requests('consume')).toHaveLength(1);
    expect(b.added).toHaveLength(1);
    expect(b.core.consumers.size).toBe(1);
    a.core.disconnect();
    b.core.disconnect();
  });

  it('a newProducer that arrives before the receive transport exists is queued, then consumed once', async () => {
    const a = createCore({ sfu });
    await a.core.connect();
    await a.core.startLocalVideo(videoTrack());
    const [producer] = sfu.producersOf(LOCAL_USER_ID);
    let transports = 0;
    sfu.override({
      type: 'createWebRtcTransport',
      times: 2,
      before: (socket) => {
        transports++;
        // Right after the send transport is created, before the recv one.
        if (transports === 2) {
          sfu.deliver(socket, {
            type: 'newProducer',
            producerId: producer?.id,
            userId: LOCAL_USER_ID,
            kind: 'video',
          });
        }
      },
    });
    // getProducers lists nothing, so only the queued announcement can deliver the track.
    sfu.override({ type: 'getProducers', data: { producers: [] } });
    const b = await connectRemote();
    await until(() => b.added.length === 1);
    await flush(20);
    const consumes = b.socket.requests('consume');
    expect(consumes).toHaveLength(1);
    expect(consumes[0]?.producerId).toBe(producer?.id);
    // It was received while connecting, before the recv transport existed.
    const newProducerIndex = b.socket.received.findIndex((m) => m.type === 'newProducer');
    expect(newProducerIndex).toBeGreaterThan(-1);
    a.core.disconnect();
    b.core.disconnect();
  });

  it("ignores announcements of the local user's own producers", async () => {
    const b = await connectRemote();
    b.socket.receive({
      type: 'newProducer',
      producerId: 'p-own',
      userId: REMOTE_USER_ID,
      kind: 'audio',
    });
    b.socket.receive({
      type: 'newProducer',
      producerId: 'p-other',
      userId: 'userC',
      kind: 'audio',
    });
    await flush(20);
    expect(b.socket.requests('consume').map((m) => m.producerId)).toEqual(['p-other']);
    b.core.disconnect();
  });

  it('stopLocalAudio(true) sends closeProducer; B drops only the audio track of A', async () => {
    const a = createCore({ sfu });
    await a.core.connect();
    const mic = await a.core.startLocalAudio(audioTrack());
    await a.core.startLocalVideo(videoTrack());
    const b = await connectRemote();
    await until(() => b.added.length === 2);

    expect(a.core.stopLocalAudio(true)).toBe(true);
    await until(() => b.removed.length === 1);
    expect(sfu.lastSocket === b.socket).toBe(true);
    expect(sfu.sockets[0]?.requests('closeProducer')).toEqual([
      expect.objectContaining({ producerId: mic?.id }),
    ]);
    expect(mic?.closed).toBe(true);
    expect(b.removed[0]).toMatchObject({ userId: LOCAL_USER_ID, kind: 'audio' });
    const tracks = b.core.getRemoteTracks(LOCAL_USER_ID);
    expect(tracks.audio).toBeUndefined();
    expect(tracks.video?.kind).toBe('video');
    // The server already closed its consumer with the producer.
    expect(b.socket.requests('closeConsumer')).toHaveLength(0);
    a.core.disconnect();
    b.core.disconnect();
  });

  it('stopLocalVideo(false) closes locally and sends nothing', async () => {
    const a = createCore({ sfu });
    await a.core.connect();
    const cam = await a.core.startLocalVideo(videoTrack());
    expect(a.core.stopLocalVideo(false)).toBe(true);
    await flush();
    expect(cam?.closed).toBe(true);
    expect(a.core.getProducer('webcam')).toBeUndefined();
    expect(sfu.lastSocket.requests('closeProducer')).toHaveLength(0);
    a.core.disconnect();
  });

  it('producerClosed for the last track removes the remote user', async () => {
    const a = createCore({ sfu });
    await a.core.connect();
    await a.core.startLocalAudio(audioTrack());
    const b = await connectRemote();
    await until(() => b.added.length === 1);
    expect(b.core.getRemoteUserIds()).toEqual([LOCAL_USER_ID]);
    a.core.stopLocalAudio(true);
    await until(() => b.removed.length === 1);
    expect(b.core.getRemoteUserIds()).toEqual([]);
    expect(b.core.consumers.size).toBe(0);
    a.core.disconnect();
    b.core.disconnect();
  });

  it('a peer that disconnects has its tracks removed from the others', async () => {
    const a = createCore({ sfu });
    await a.core.connect();
    await a.core.startLocalAudio(audioTrack());
    await a.core.startLocalVideo(videoTrack());
    const b = await connectRemote();
    await until(() => b.added.length === 2);
    a.core.disconnect();
    await until(() => b.removed.length === 2);
    expect(b.core.getRemoteUserIds()).toEqual([]);
    b.core.disconnect();
  });

  it('producerPaused / producerResumed from the SFU update the remote track and emit consumerUpdated', async () => {
    const a = createCore({ sfu });
    await a.core.connect();
    await a.core.startLocalAudio(audioTrack());
    const b = await connectRemote();
    await until(() => b.added.length === 1);

    a.core.pauseProducer('mic');
    await until(() => b.updated.length === 1);
    expect(b.updated[0]).toMatchObject({
      userId: LOCAL_USER_ID,
      kind: 'audio',
      producerPaused: true,
    });
    expect(b.core.getRemoteTrackInfo(LOCAL_USER_ID).audio?.producerPaused).toBe(true);

    a.core.resumeProducer('mic');
    await until(() => b.updated.length === 2);
    expect(b.updated[1]?.producerPaused).toBe(false);
    expect(b.core.getRemoteTrackInfo(LOCAL_USER_ID).audio?.producerPaused).toBe(false);
    a.core.disconnect();
    b.core.disconnect();
  });

  it('closeConsumer stops receiving and tells the server', async () => {
    const a = createCore({ sfu });
    await a.core.connect();
    await a.core.startLocalAudio(audioTrack());
    const b = await connectRemote();
    await until(() => b.added.length === 1);
    const consumerId = b.added[0]?.consumerId as string;
    expect(b.core.closeConsumer(consumerId)).toBe(true);
    await flush();
    expect(b.socket.requests('closeConsumer')).toEqual([expect.objectContaining({ consumerId })]);
    expect(b.core.getRemoteUserIds()).toEqual([]);
    expect(b.core.closeConsumer(consumerId)).toBe(false);
    a.core.disconnect();
    b.core.disconnect();
  });
});

describe('connection failures', () => {
  it('a transport-creation failure rejects, leaves no transports and does not retry', async () => {
    sfu.override({ type: 'createWebRtcTransport', error: 'no transport' });
    const { core } = createCore({ sfu });
    await expect(core.connect()).rejects.toThrow('no transport');
    expect(core.isConnected).toBe(false);
    expect(core.state).toBe('failed');
    expect(core.sendTransport).toBeNull();
    expect(core.recvTransport).toBeNull();
    await flush(80);
    expect(sfu.sockets).toHaveLength(1);
  });

  it('produce while disconnected throws instead of queueing', async () => {
    const { core } = createCore({ sfu });
    await expect(core.startLocalAudio(audioTrack())).rejects.toThrow('Not connected');
    expect(sfu.sockets).toHaveLength(0);
  });
});
