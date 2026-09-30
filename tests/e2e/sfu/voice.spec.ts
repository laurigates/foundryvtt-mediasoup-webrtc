/**
 * Voice modes end to end. Core decides WHEN to broadcast (push-to-talk key,
 * voice-level analysis); the host page does not reproduce that. The spec
 * hands AVMaster the decision directly (`__e2e.pushToTalk`, `__e2e.speak`,
 * or a voice-mode change through AVSettings) and asserts what the module
 * makes of it: its mic producer paused/resumed at the SFU (the paused flag
 * reaches the OTHER peer), the other peer's decoded audio energy flat or
 * growing, the local track state, and the local speaking indicator.
 */

import type { Page } from '@playwright/test';
import { expect, type Peer, test } from './support/peer.js';

/** The last `speaking` state this peer broadcast to the others. */
async function lastSpeaking(peer: Peer): Promise<boolean | undefined> {
  return (await peer.activity()).filter((act) => act.av && 'speaking' in act.av).at(-1)?.av
    ?.speaking;
}

const users = ['alice', 'bob'];

async function micPausedOnBob(bob: Peer): Promise<boolean | undefined> {
  return (await bob.consumersOfKind('alice', 'audio'))[0]?.producerPaused;
}

/** Press (true) or release (false) the push-to-talk key; false if PTT is not active. */
function pushToTalk(page: Page, down: boolean): Promise<boolean> {
  return page.evaluate((d) => window.__e2e.pushToTalk(d), down);
}

/** Voice activation's verdict for Alice; false if detection is not armed. */
function speak(page: Page, speaking: boolean): Promise<boolean> {
  return page.evaluate((v) => window.__e2e.speak(v), speaking);
}

test('push-to-talk: the microphone is silent until the key is held, and stops after release', async ({
  peers,
}) => {
  const a = await peers({ user: 'alice', users, voice: 'ptt' });
  const b = await peers({ user: 'bob', users });
  expect(await a.connect()).toBe(true);
  expect(await b.connect()).toBe(true);
  await b.expectConsuming('alice');

  // Not talking: the mic producer exists but is paused, and nothing is heard.
  expect(await micPausedOnBob(b)).toBe(true);
  const idle = await a.status();
  expect(idle.broadcasting).toBe(false);
  expect(idle.localTracks.sort()).toEqual(['audio:disabled', 'video:enabled']);
  await b.expectAudioStalled('alice');
  const before = (await b.inbound('alice')).audio;

  // Key down.
  expect(await pushToTalk(a.page, true)).toBe(true);
  await expect.poll(() => micPausedOnBob(b)).toBe(false);
  expect((await a.status()).broadcasting).toBe(true);
  expect((await a.status()).localTracks.sort()).toEqual(['audio:enabled', 'video:enabled']);
  await b.expectAudioResumed('alice', before);
  expect(await lastSpeaking(a)).toBe(true);
  expect((await a.tile('alice')).speaking).toBe(true);

  // Key up.
  expect(await pushToTalk(a.page, false)).toBe(true);
  await expect.poll(() => micPausedOnBob(b)).toBe(true);
  expect((await a.status()).broadcasting).toBe(false);
  expect((await a.status()).localTracks.sort()).toEqual(['audio:disabled', 'video:enabled']);
  await b.expectAudioStalled('alice');
  expect(await lastSpeaking(a)).toBe(false);
  expect((await a.tile('alice')).speaking).toBe(false);
  // Video was never affected.
  await b.expectReceiving('alice', ['video']);
});

test('voice activation: the detection verdict opens and closes the microphone', async ({
  peers,
}) => {
  const a = await peers({ user: 'alice', users, voice: 'activity' });
  const b = await peers({ user: 'bob', users });
  expect(await a.connect()).toBe(true);
  expect(await b.connect()).toBe(true);
  await b.expectConsuming('alice');

  // Detection watches the client's levels stream, whose mic track must stay
  // enabled while the sent track is paused, or nothing could ever be heard.
  const starts = (await a.levelReports()).filter((r) => r.op === 'start' && r.id === 'alice');
  expect(starts.at(-1)).toMatchObject({ audioTracks: 1, enabledAudioTracks: 1 });
  expect(await micPausedOnBob(b)).toBe(true);
  expect((await a.status()).broadcasting).toBe(false);
  await b.expectAudioStalled('alice');
  const before = (await b.inbound('alice')).audio;

  // PTT is not the active mode: the key does nothing.
  expect(await pushToTalk(a.page, true)).toBe(false);
  expect(await micPausedOnBob(b)).toBe(true);

  // Talking.
  expect(await speak(a.page, true)).toBe(true);
  await expect.poll(() => micPausedOnBob(b)).toBe(false);
  expect((await a.status()).broadcasting).toBe(true);
  await b.expectAudioResumed('alice', before);

  // Silent again.
  expect(await speak(a.page, false)).toBe(true);
  await expect.poll(() => micPausedOnBob(b)).toBe(true);
  expect((await a.status()).broadcasting).toBe(false);
  await b.expectAudioStalled('alice');
});

test('switching the voice mode mid-session re-arms broadcast and voice detection', async ({
  peers,
}) => {
  const a = await peers({ user: 'alice', users, voice: 'ptt' });
  const b = await peers({ user: 'bob', users });
  expect(await a.connect()).toBe(true);
  expect(await b.connect()).toBe(true);
  await b.expectConsuming('alice');
  expect(await micPausedOnBob(b)).toBe(true);
  // Push-to-talk arms no voice detection.
  expect(await speak(a.page, true)).toBe(false);
  const muted = (await b.inbound('alice')).audio;

  // ptt -> always: the module asks AVMaster to broadcast, so Bob hears
  // Alice, and it restores the speaking indicator that re-arming voice
  // detection cleared.
  await a.setClientSetting('voice.mode', 'always');
  await expect.poll(() => micPausedOnBob(b)).toBe(false);
  await expect.poll(async () => (await a.status()).broadcasting).toBe(true);
  expect(await lastSpeaking(a)).toBe(true);
  expect((await a.tile('alice')).speaking).toBe(true);
  await b.expectAudioResumed('alice', muted);

  // always -> activity: paused until speech; the module re-arms voice
  // detection on its levels stream, and the detector's verdict drives it.
  const reportsBefore = (await a.levelReports()).length;
  await a.setClientSetting('voice.mode', 'activity');
  await expect.poll(() => micPausedOnBob(b)).toBe(true);
  await expect.poll(async () => (await a.status()).broadcasting).toBe(false);
  expect(await lastSpeaking(a)).toBe(false);
  await expect
    .poll(async () =>
      (await a.levelReports())
        .slice(reportsBefore)
        .filter((r) => r.op === 'start' && r.id === 'alice' && r.enabledAudioTracks === 1),
    )
    .toHaveLength(1);
  expect((await a.tile('alice')).speaking).toBe(false);
  expect(await speak(a.page, true)).toBe(true);
  await expect.poll(() => micPausedOnBob(b)).toBe(false);

  // activity -> ptt: paused, detection disarmed.
  await a.setClientSetting('voice.mode', 'ptt');
  await expect.poll(() => micPausedOnBob(b)).toBe(true);
  await expect.poll(async () => (await a.status()).broadcasting).toBe(false);
  expect(await speak(a.page, true)).toBe(false);
  await b.expectAudioStalled('alice');
});
