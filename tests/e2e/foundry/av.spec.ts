/**
 * Audio and video flow browser -> SFU -> browser inside real Foundry.
 *
 * The GM and a TRUSTED player log in from separate browser contexts with
 * Chromium's fake camera and microphone. Core AVMaster connects each
 * MediaSoupAVClient to the real Rust SFU (the URL/token global setup saved in
 * the world settings) and core CameraViews renders the dock. The assertions
 * read what core rendered and the WebRTC stats of the SFU consumers, so they
 * fail unless media really arrives and plays.
 */

import {
  clientStatus,
  consumerKinds,
  expectConnected,
  expectPlayingRemoteTile,
  expectReceiving,
  setVoiceAlways,
} from './support/av-probe.js';
import { expect, test } from './support/fixtures.js';

test('the GM sees and hears the player: a playing <video> fed by SFU consumers', async ({
  login,
}) => {
  const gm = await login('gm');
  const player = await login('player');
  for (const session of [gm, player]) await setVoiceAlways(session.page);
  await expectConnected(gm.page, 'GM');
  await expectConnected(player.page, 'player');

  // Preconditions, so a failure below is about media and not about the fixture.
  const permissions = await player.page.evaluate(() => {
    const g = globalThis as any;
    const id = g.game.user.id;
    return {
      video: g.game.webrtc.canUserBroadcastVideo(id),
      audio: g.game.webrtc.canUserBroadcastAudio(id),
    };
  });
  expect(permissions, 'the player may broadcast audio and video').toEqual({
    video: true,
    audio: true,
  });
  // Voice mode "always" and the camera shown: both producers exist, unpaused.
  await expect
    .poll(
      async () =>
        (await clientStatus(player.page)).producers
          .map((p) => `${p.kind}:${p.paused ? 'paused' : 'live'}`)
          .sort(),
      { message: 'the player produces unpaused audio and video', timeout: 30_000 },
    )
    .toEqual(['audio:live', 'video:live']);

  // The GM's client sees the player and consumes both of the player's producers.
  await expect
    .poll(async () => (await clientStatus(gm.page)).connectedUsers.includes(player.userId), {
      message: 'the GM client lists the player as connected',
      timeout: 30_000,
    })
    .toBe(true);
  await expect
    .poll(() => consumerKinds(gm.page, player.userId), {
      message: 'the GM consumes the player’s audio and video',
      timeout: 30_000,
    })
    .toEqual(['audio:live', 'video:live']);

  // Core's camera dock on the GM's screen plays the player's camera.
  await expectPlayingRemoteTile(gm.page, player.userId, 'GM');
  await expectReceiving(gm.page, player.userId, 'GM');

  // And the other way round.
  await expectPlayingRemoteTile(player.page, gm.userId, 'player');
  await expectReceiving(player.page, gm.userId, 'player');
});

test('when the player leaves, the GM drops their consumers and camera tile', async ({ login }) => {
  const gm = await login('gm');
  const player = await login('player');
  await expectConnected(gm.page, 'GM');
  await expectConnected(player.page, 'player');
  await expect
    .poll(() => consumerKinds(gm.page, player.userId), {
      message: 'the GM consumes the player’s tracks',
      timeout: 30_000,
    })
    .toEqual(['audio:live', 'video:live']);

  await player.context.close();

  await expect
    .poll(() => consumerKinds(gm.page, player.userId), {
      message: 'the GM closes the consumers of a player who left',
      timeout: 30_000,
    })
    .toEqual([]);
  await expect
    .poll(async () => (await clientStatus(gm.page)).connectedUsers.includes(player.userId), {
      message: 'the GM client no longer lists the player',
      timeout: 30_000,
    })
    .toBe(false);
  // The GM's own session is unaffected.
  expect((await clientStatus(gm.page)).isConnected).toBe(true);
});
