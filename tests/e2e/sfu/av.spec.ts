/**
 * Audio and video flow browser -> SFU -> browser through the real bundle.
 *
 * Every peer is a separate browser context running the host page, connected
 * the way core does it (AVMaster#connect -> initialize() + connect()), with
 * Chromium's fake camera and microphone. Assertions read the consumers the
 * client holds, the dock tiles CameraViews renders via setUserVideo (read
 * without forcing a render, so the client must re-render by itself), the
 * pixels those tiles show, and WebRTC inbound-rtp stats including the decoded
 * audio energy, so they fail if media does not actually flow, or flows as
 * black frames or silence.
 */

import { expect, test } from './support/peer.js';

test('two users exchange live audio and video through the SFU', async ({ peers }) => {
  const users = ['alice', 'bob'];
  const a = await peers({ user: 'alice', users });
  const b = await peers({ user: 'bob', users });

  expect(await a.connect()).toBe(true);
  const rendersBeforeBob = (await a.status()).renders;
  expect(await b.connect()).toBe(true);
  for (const peer of [a, b]) {
    const status = await peer.status();
    expect(status.state).toBe('connected');
    expect(status.isConnected).toBe(true);
    expect(status.audioEnabled).toBe(true);
    expect(status.videoEnabled).toBe(true);
    // Voice mode "always", not muted or hidden: both local tracks are live.
    expect(status.localTracks.sort()).toEqual(['audio:enabled', 'video:enabled']);
    expect(status.broadcasting).toBe(true);
    expect([...status.connectedUsers].sort()).toEqual(users);
  }

  await a.expectConsuming('bob');
  await b.expectConsuming('alice');
  // Bob's tracks reached Alice after her own connect: only the client's own
  // re-render (on consumerAdded) can have put them in her dock.
  expect((await a.status()).renders).toBeGreaterThan(rendersBeforeBob);

  // getMediaStreamForUser -> setUserVideo -> a playing <video> in the dock.
  await a.expectVideoTile('bob');
  await b.expectVideoTile('alice');
  const tileOnA = await a.tile('bob');
  expect(tileOnA.trackKinds?.sort()).toEqual(['audio:live', 'video:live']);
  expect(tileOnA.muted).toBe(false);
  expect(tileOnA.audioPausedMarker).toBe(false);
  expect(tileOnA.videoPausedMarker).toBe(false);
  const selfTile = await a.tile('alice');
  expect(selfTile.hasStream).toBe(true);
  expect(selfTile.isLocalStream).toBe(true);
  expect(selfTile.isClientStream).toBe(true);
  expect(selfTile.muted).toBe(true); // never play back the local microphone
  // The remote levels stream (core's speaking indicator) holds Bob's live audio.
  expect(
    await a.page.evaluate(() =>
      window.game.webrtc.client
        .getLevelsStreamForUser('bob')
        ?.getAudioTracks()
        .map((t: MediaStreamTrack) => t.readyState),
    ),
  ).toEqual(['live']);

  await a.expectReceiving('bob');
  await b.expectReceiving('alice');

  // "Mute all" in Configure Audio/Video: the client re-renders by itself and
  // setUserVideo mutes the remote tile; turning it off unmutes it again.
  await a.setClientSetting('muteAll', true);
  await expect.poll(async () => (await a.tile('bob')).muted).toBe(true);
  await a.setClientSetting('muteAll', false);
  await expect.poll(async () => (await a.tile('bob')).muted).toBe(false);
});

test('a late joiner receives the tracks of a peer that is already producing', async ({ peers }) => {
  const users = ['alice', 'bob'];
  const a = await peers({ user: 'alice', users });
  expect(await a.connect()).toBe(true);

  // Alice is already sending both tracks to the SFU before Bob exists.
  await expect
    .poll(
      async () => {
        const out = await a.outbound();
        return [out.mic?.packetsSent ?? 0, out.webcam?.packetsSent ?? 0].every((n) => n > 0);
      },
      { message: 'alice sends audio and video', timeout: 20_000 },
    )
    .toBe(true);
  expect((await a.status()).remoteUsers).toEqual([]);

  const b = await peers({ user: 'bob', users });
  expect(await b.connect()).toBe(true);

  await b.expectConsuming('alice');
  await b.expectVideoTile('alice');
  await b.expectReceiving('alice');
  // And Alice picks up the newcomer's producers (newProducer notifications).
  await a.expectConsuming('bob');
  await a.expectReceiving('bob');
});

test('mute and hide pause the remote tracks; unmute and show resume them', async ({ peers }) => {
  const users = ['alice', 'bob'];
  const a = await peers({ user: 'alice', users });
  const b = await peers({ user: 'bob', users });
  expect(await a.connect()).toBe(true);
  expect(await b.connect()).toBe(true);
  await b.expectConsuming('alice');
  await b.expectReceiving('alice');

  const audioOf = async () => (await b.consumersOfKind('alice', 'audio'))[0];
  const packets = async (kind: 'audio' | 'video') =>
    (await b.inbound('alice'))[kind]?.packetsReceived ?? 0;
  const consumerBefore = (await audioOf())?.consumerId;
  expect(consumerBefore).toBeTruthy();
  expect((await audioOf())?.producerPaused).toBe(false);

  // Mute through AVSettings, as the camera dock's mute button does.
  await a.setClientSetting('users.alice.muted', true);
  await expect.poll(async () => (await audioOf())?.producerPaused).toBe(true);
  await expect
    .poll(async () => (await a.status()).producers.find((p) => p.tag === 'mic')?.paused)
    .toBe(true);
  expect((await a.status()).localTracks.sort()).toEqual(['audio:disabled', 'video:enabled']);
  await expect.poll(async () => (await b.tile('alice')).audioPausedMarker).toBe(true);
  // The SFU stops forwarding: audio packets and energy stall while video keeps flowing.
  const video1 = await packets('video');
  await b.expectAudioStalled('alice');
  expect(await packets('video')).toBeGreaterThan(video1);
  // Paused, not closed: the same consumer stays.
  expect((await audioOf())?.consumerId).toBe(consumerBefore);
  const muted = (await b.inbound('alice')).audio;

  await a.setClientSetting('users.alice.muted', false);
  await expect.poll(async () => (await audioOf())?.producerPaused).toBe(false);
  await expect.poll(async () => (await b.tile('alice')).audioPausedMarker).toBe(false);
  expect((await a.status()).localTracks.sort()).toEqual(['audio:enabled', 'video:enabled']);
  // Audible again, not just packets: a still-disabled track would send silence.
  await b.expectAudioResumed('alice', muted);
  expect((await audioOf())?.consumerId).toBe(consumerBefore);

  // Hide the camera: the video producer pauses the same way.
  const videoOf = async () => (await b.consumersOfKind('alice', 'video'))[0];
  await a.setClientSetting('users.alice.hidden', true);
  await expect.poll(async () => (await videoOf())?.producerPaused).toBe(true);
  expect((await a.status()).localTracks.sort()).toEqual(['audio:enabled', 'video:disabled']);
  await expect.poll(async () => (await b.tile('alice')).videoPausedMarker).toBe(true);
  await b.page.waitForTimeout(1_000);
  const hidden1 = await packets('video');
  await b.page.waitForTimeout(1_500);
  expect(await packets('video')).toBe(hidden1);

  await a.setClientSetting('users.alice.hidden', false);
  await expect.poll(async () => (await videoOf())?.producerPaused).toBe(false);
  await expect.poll(async () => (await b.tile('alice')).videoPausedMarker).toBe(false);
  expect((await a.status()).localTracks.sort()).toEqual(['audio:enabled', 'video:enabled']);
  // Real pictures again (a still-disabled track would send black frames).
  await b.expectReceiving('alice');
});

test('turning the microphone off and on replaces the remote audio consumer', async ({ peers }) => {
  const users = ['alice', 'bob'];
  const a = await peers({ user: 'alice', users });
  const b = await peers({ user: 'bob', users });
  expect(await a.connect()).toBe(true);
  expect(await b.connect()).toBe(true);
  await b.expectConsuming('alice');
  const [audioBefore] = await b.consumersOfKind('alice', 'audio');
  const [videoBefore] = await b.consumersOfKind('alice', 'video');

  // "Disabled" audio source in Configure Audio/Video: the mic producer closes.
  await a.setClientSetting('audioSrc', 'disabled');
  await expect
    .poll(async () => (await b.consumersOfKind('alice', 'audio')).length, { timeout: 15_000 })
    .toBe(0);
  await expect
    .poll(async () => (await a.status()).producers.map((p) => p.tag).sort())
    .toEqual(['webcam']);
  expect((await a.status()).audioEnabled).toBe(false);
  // Video keeps flowing on the same consumer.
  await b.expectReceiving('alice', ['video']);
  expect((await b.consumersOfKind('alice', 'video'))[0]?.consumerId).toBe(videoBefore?.consumerId);
  await expect.poll(async () => (await b.tile('alice')).trackKinds).toEqual(['video:live']);

  // Back to the default device: exactly one new audio consumer.
  await a.setClientSetting('audioSrc', 'default');
  await expect
    .poll(async () => (await b.consumersOfKind('alice', 'audio')).length, { timeout: 15_000 })
    .toBe(1);
  await b.expectReceiving('alice');
  await b.page.waitForTimeout(1_000);
  const audioAfter = await b.consumersOfKind('alice', 'audio');
  expect(audioAfter).toHaveLength(1);
  expect(audioAfter[0]?.consumerId).not.toBe(audioBefore?.consumerId);
  expect(audioAfter[0]?.producerId).not.toBe(audioBefore?.producerId);
  expect(await b.consumersOfKind('alice', 'video')).toHaveLength(1);
});

test('a wrong auth token is rejected and reported', async ({ peers }) => {
  const a = await peers({ user: 'mallory', token: 'definitely-not-the-token' });

  expect(await a.connect()).toBe(false);
  const status = await a.status();
  expect(status.state).toBe('failed');
  expect(status.isConnected).toBe(false);
  // connect() gave up before capturing: no camera or microphone opened.
  expect(status.audioEnabled).toBe(false);
  expect(status.videoEnabled).toBe(false);
  const errors = (await a.notifications()).filter((n) => n.level === 'error');
  expect(errors.map((n) => n.message).join('\n')).toMatch(/authentication failed/i);

  // A rejected token is final: no reconnect loop.
  await a.page.waitForTimeout(2_500);
  expect(await a.transportStates()).not.toContain('reconnecting');
  expect((await a.status()).state).toBe('failed');

  // Fixing the world setting reconnects (the setting's onChange), and now it works.
  await a.page.evaluate((token) => {
    window.game.settings.set('mediasoup-vtt', 'mediaSoupAuthToken', token);
  }, process.env.E2E_SFU_TOKEN);
  await expect.poll(async () => (await a.status()).state, { timeout: 15_000 }).toBe('connected');
});

test('closing a peer removes its tracks from the others', async ({ peers }) => {
  const users = ['alice', 'bob', 'carol'];
  const a = await peers({ user: 'alice', users });
  const b = await peers({ user: 'bob', users });
  const c = await peers({ user: 'carol', users });
  for (const peer of [a, b, c]) expect(await peer.connect()).toBe(true);
  await b.expectConsuming('alice');
  await b.expectConsuming('carol');
  await b.expectVideoTile('alice');

  await a.close();

  await expect.poll(async () => (await b.remoteConsumers('alice')).length).toBe(0);
  await expect.poll(async () => (await c.remoteConsumers('alice')).length).toBe(0);
  expect((await b.status()).remoteUsers).not.toContain('alice');
  await expect.poll(async () => (await b.tile('alice')).hasStream ?? false).toBe(false);
  expect(
    await b.page.evaluate(() => window.game.webrtc.client.getMediaStreamForUser('alice') === null),
  ).toBe(true);

  // The others are unaffected.
  expect((await b.status()).state).toBe('connected');
  await b.expectReceiving('carol');
  await c.expectReceiving('bob');
});
