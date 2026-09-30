/**
 * Recovery in the transport core: ICE restarts on a failed transport, and
 * the backoff reconnect loop after an unexpected signaling loss.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReconnectScheduled } from '../../src/client/MediaSoupVTTClient';
import { FakeSfu } from './helpers/fake-ws';
import { LOCAL_USER_ID } from './helpers/foundry-v14';
import { audioTrack, videoTrack } from './helpers/media';
import { createCore, flush, TOKEN, until } from './helpers/peers';

let sfu: FakeSfu;

beforeEach(() => {
  sfu = new FakeSfu({ token: TOKEN });
});

async function connected() {
  const harness = createCore({ sfu });
  await harness.core.connect();
  await flush();
  const send = harness.handlers.find((h) => h.direction === 'send');
  const recv = harness.handlers.find((h) => h.direction === 'recv');
  if (!send || !recv) throw new Error('transport handlers were not created');
  return { ...harness, send: send.handler, recv: recv.handler, socket: sfu.lastSocket };
}

describe('ICE recovery', () => {
  it('a failed transport triggers restartIce and applies the returned iceParameters', async () => {
    const { core, send, socket } = await connected();
    const transport = core.sendTransport;
    if (!transport) throw new Error('no send transport');
    const restart = vi.spyOn(transport, 'restartIce');
    send.setConnectionState('failed');
    await until(() => restart.mock.calls.length === 1);
    const [request] = socket.requests('restartIce');
    expect(request).toMatchObject({ transportId: transport.id });
    const iceParameters = restart.mock.calls[0]?.[0]?.iceParameters;
    expect(iceParameters?.usernameFragment).toEqual(expect.any(String));
    expect(iceParameters?.password).toEqual(expect.any(String));
    // The same socket, not a reconnect.
    expect(sfu.sockets).toHaveLength(1);
    core.disconnect();
  });

  it('a transport that recovers from "disconnected" within the grace period is not restarted', async () => {
    const { core, recv, socket } = await connected();
    recv.setConnectionState('connected');
    recv.setConnectionState('disconnected');
    await flush(5);
    recv.setConnectionState('connected');
    await flush(40);
    expect(socket.requests('restartIce')).toHaveLength(0);
    core.disconnect();
  });

  it('a transport still "disconnected" after the grace period is restarted', async () => {
    const { core, recv, socket } = await connected();
    recv.setConnectionState('connected');
    recv.setConnectionState('disconnected');
    await flush(5);
    expect(socket.requests('restartIce')).toHaveLength(0);
    await until(() => socket.requests('restartIce').length === 1);
    expect(socket.requests('restartIce')[0]?.transportId).toBe(core.recvTransport?.id);
    core.disconnect();
  });

  it('falls back to a full reconnect after the ICE restart budget is spent', async () => {
    const { core, send, socket } = await connected();
    send.setConnectionState('failed');
    // Restart 1 now, restart 2 after the grace period, then a full reconnect.
    await until(() => socket.requests('restartIce').length === 2);
    await until(() => sfu.sockets.length === 2);
    await until(() => core.isConnected);
    expect(socket.requests('restartIce')).toHaveLength(2);
    expect(sfu.lastSocket.sent[0]).toMatchObject({ type: 'authenticate', reconnect: true });
    core.disconnect();
  });
});

describe('reconnect after a signaling loss', () => {
  it('an unclean close starts one backoff loop that re-joins, re-produces and re-lists producers', async () => {
    const { core } = await connected();
    const mic = audioTrack();
    await core.startLocalAudio(mic, { paused: true });
    await core.startLocalVideo(videoTrack());
    const scheduled: ReconnectScheduled[] = [];
    const states: string[] = [];
    core.on('reconnecting', (e) => scheduled.push(e));
    core.on('stateChanged', (s) => states.push(s.state));

    // serverClose(1006) fires onerror and onclose, like a browser.
    sfu.sockets[0]?.serverClose(1006);
    expect(core.state).toBe('reconnecting');
    expect(core.isConnected).toBe(false);
    await until(() => core.isConnected);
    await flush(20);

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ attempt: 1, maxAttempts: 3 });
    expect(scheduled[0]?.delayMs).toBeGreaterThanOrEqual(10);
    expect(scheduled[0]?.delayMs).toBeLessThanOrEqual(40);
    expect(sfu.sockets).toHaveLength(2);
    const second = sfu.lastSocket;
    expect(second.sent[0]).toMatchObject({
      type: 'authenticate',
      reconnect: true,
      sessionId: core.sessionId,
    });
    expect(second.requests('getProducers')).toHaveLength(1);
    // The wanted tracks come back with their pause state, on the same track objects.
    expect(
      second
        .requests('produce')
        .map((m) => [m.kind, m.paused])
        .sort(),
    ).toEqual([
      ['audio', true],
      ['video', false],
    ]);
    expect(core.getProducer('mic')?.track).toBe(mic);
    expect(states).toEqual(['reconnecting', 'connected']);
    core.disconnect();
  });

  it('a reconnected peer is consumed again by the other peer', async () => {
    const a = await connected();
    await a.core.startLocalAudio(audioTrack());
    const b = createCore({ sfu, userId: 'userB' });
    const added: string[] = [];
    b.core.on('consumerAdded', (i) => added.push(i.producerId));
    await b.core.connect();
    await until(() => added.length === 1);

    a.socket.serverClose(1006);
    await until(() => a.core.isConnected);
    // The re-produced track is announced to B as a new producer.
    await until(() => added.length === 2);
    expect(added[0]).not.toBe(added[1]);
    expect(b.core.getRemoteTracks(LOCAL_USER_ID).audio?.kind).toBe('audio');
    expect(b.core.consumers.size).toBe(1);
    a.core.disconnect();
    b.core.disconnect();
  });

  it('does not reconnect after a user disconnect', async () => {
    const { core } = await connected();
    const scheduled = vi.fn();
    core.on('reconnecting', scheduled);
    core.disconnect();
    await flush(80);
    expect(sfu.sockets).toHaveLength(1);
    expect(scheduled).not.toHaveBeenCalled();
    expect(core.state).toBe('disconnected');
  });

  it('does not reconnect when the server replaced the connection (close code 4001)', async () => {
    const { core, socket } = await connected();
    socket.serverClose(4001, 'Replaced by a newer connection for the same user');
    await flush(80);
    expect(core.state).toBe('failed');
    expect(sfu.sockets).toHaveLength(1);
  });

  it('gives up after the maximum number of attempts', async () => {
    const { core, socket } = await connected();
    sfu.override({ type: 'createWebRtcTransport', error: 'no transport', times: 100 });
    const scheduled: number[] = [];
    core.on('reconnecting', (e) => scheduled.push(e.attempt));
    socket.serverClose(1006);
    await until(() => core.state === 'failed', 2000);
    expect(scheduled).toEqual([1, 2, 3]);
    expect(sfu.sockets).toHaveLength(1 + 3);
    await flush(80);
    expect(sfu.sockets).toHaveLength(4);
  });

  it('stops at once when the server rejects the token during a reconnect', async () => {
    const { core, socket } = await connected();
    sfu.override({ type: 'authenticate', error: 'Invalid authentication token', times: 100 });
    socket.serverClose(1006);
    await until(() => core.state === 'failed');
    await flush(80);
    expect(sfu.sockets).toHaveLength(2);
  });
});
