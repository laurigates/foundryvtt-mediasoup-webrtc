/**
 * MediaSoupAVClient driven through the v14 AVMaster / AVSettings fakes and
 * the fake SFU: capture from the AVSettings devices, push-to-talk, mute,
 * hide, device switches, remote users in the camera views, and failures.
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { FakeSfu } from './helpers/fake-ws';
import {
  AVSettings,
  cancelPendingAVSettings,
  foundryEnv,
  LOCAL_USER_ID,
  REMOTE_USER_ID,
  VOICE_THRESHOLD_DB,
} from './helpers/foundry-v14';
import { audioTrack, videoTrack } from './helpers/media';
import { createAVClient, createCore, flush, TOKEN, until } from './helpers/peers';

const env = foundryEnv();
const gum = () => navigator.mediaDevices.getUserMedia as unknown as Mock;
let sfu: FakeSfu;
let cleanup: Array<() => unknown>;

beforeEach(() => {
  sfu = new FakeSfu({ token: TOKEN });
  cleanup = [];
  gum().mockClear();
  env.cameraViews.render.mockClear();
  env.cameraViews.setUserIsSpeaking.mockClear();
  env.audio.startLevelReports.mockClear();
  env.audio.stopLevelReports.mockClear();
  for (const fn of Object.values(env.notifications)) fn.mockClear();
});

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  // AVSettings reports changes on a later task; drop any still pending.
  cancelPendingAVSettings();
  env.cameraViews.videos.clear();
  env.cameraViews.speaking.clear();
  env.audio.levelHandlers.clear();
  env.game.webrtc = undefined;
});

/** The local microphone / camera track, as the producers send it. */
function localTrack(client: { localStream: MediaStream | null }, kind: 'audio' | 'video') {
  return kind === 'audio'
    ? client.localStream?.getAudioTracks()[0]
    : client.localStream?.getVideoTracks()[0];
}

function av(options: Omit<Parameters<typeof createAVClient>[0], 'sfu'> = {}) {
  const harness = createAVClient({ sfu, ...options });
  cleanup.push(() => harness.client.destroy());
  return harness;
}

function localProducer(kind: 'audio' | 'video') {
  return sfu.producersOf(LOCAL_USER_ID).find((p) => p.kind === kind);
}

/** The remote user as a second SFU peer. */
async function remotePeer() {
  const { core } = createCore({ sfu, userId: REMOTE_USER_ID });
  cleanup.push(() => core.disconnect());
  await core.connect();
  return core;
}

describe('capture and send', () => {
  it('captures the AVSettings devices and sends both tracks (push-to-talk starts the mic paused)', async () => {
    const { master, client } = av({
      settings: { audioSrc: 'mic-2', videoSrc: 'cam-1', voiceMode: 'ptt' },
    });
    expect(await master.connect()).toBe(true);
    await flush(20);

    expect(gum()).toHaveBeenCalledTimes(1);
    const constraints = gum().mock.calls[0]?.[0];
    expect(constraints.audio).toEqual({ deviceId: { ideal: 'mic-2' } });
    expect(constraints.video).toMatchObject({ deviceId: { ideal: 'cam-1' } });

    expect(localProducer('audio')?.paused).toBe(true);
    expect(localProducer('video')?.paused).toBe(false);
    expect(client.isAudioEnabled()).toBe(true);
    expect(client.isVideoEnabled()).toBe(true);
    expect(client.getMediaStreamForUser(LOCAL_USER_ID)).toBe(client.localStream);
    // The levels stream holds a clone, so voice detection survives a paused producer.
    const levels = client.getLevelsStreamForUser(LOCAL_USER_ID);
    expect(levels?.getAudioTracks()).toHaveLength(1);
    expect(levels?.getAudioTracks()[0]).not.toBe(client.localStream?.getAudioTracks()[0]);
  });

  it('in "always" mode the microphone is live on the server', async () => {
    const { master, client } = av({ settings: { voiceMode: 'always' } });
    expect(await master.connect()).toBe(true);
    await flush(20);
    expect(localProducer('audio')?.paused).toBe(false);
    expect(master.broadcasting).toBe(true);
    // The sent tracks are enabled: a disabled track would send silence / black.
    expect(localTrack(client, 'audio')?.enabled).toBe(true);
    expect(localTrack(client, 'video')?.enabled).toBe(true);
  });

  it('push-to-talk press and release resume and pause the mic producer on the server', async () => {
    const { master, client } = av({ settings: { voiceMode: 'ptt' } });
    await master.connect();
    await flush(20);
    master.broadcast(true);
    await until(() => localProducer('audio')?.paused === false);
    expect(client.audioBroadcastEnabled).toBe(true);
    expect(client.localStream?.getAudioTracks()[0]?.enabled).toBe(true);
    master.broadcast(false);
    await until(() => localProducer('audio')?.paused === true);
    expect(client.localStream?.getAudioTracks()[0]?.enabled).toBe(false);
  });

  it('a muted user never broadcasts, even when push-to-talk is pressed', async () => {
    const { master, client, settings } = av({ settings: { voiceMode: 'always' } });
    await master.connect();
    await flush(20);
    expect(localProducer('audio')?.paused).toBe(false);

    settings.set('client', `users.${LOCAL_USER_ID}.muted`, true);
    await until(() => localProducer('audio')?.paused === true);
    expect(localTrack(client, 'audio')?.enabled).toBe(false);
    client.toggleBroadcast(true);
    await flush(20);
    expect(localProducer('audio')?.paused).toBe(true);
    expect(client.audioBroadcastEnabled).toBe(false);
    expect(localTrack(client, 'audio')?.enabled).toBe(false);

    settings.set('client', `users.${LOCAL_USER_ID}.muted`, false);
    await until(() => localProducer('audio')?.paused === false);
    expect(localTrack(client, 'audio')?.enabled).toBe(true);
  });

  it('hiding the camera pauses the webcam producer and showing it resumes it', async () => {
    const { master, client, settings } = av();
    await master.connect();
    await flush(20);
    expect(localTrack(client, 'video')?.enabled).toBe(true);
    settings.set('client', `users.${LOCAL_USER_ID}.hidden`, true);
    await until(() => localProducer('video')?.paused === true);
    expect(localTrack(client, 'video')?.enabled).toBe(false);
    settings.set('client', `users.${LOCAL_USER_ID}.hidden`, false);
    await until(() => localProducer('video')?.paused === false);
    expect(localTrack(client, 'video')?.enabled).toBe(true);
  });

  it('a device change re-captures and swaps the track into the existing producer (replaceTrack)', async () => {
    const { master, client, core, settings } = av({ settings: { audioSrc: 'mic-1' } });
    await master.connect();
    await flush(20);
    const producer = core.getProducer('mic');
    const oldTrack = client.localStream?.getAudioTracks()[0];
    const producesBefore = sfu.requests('produce').length;

    settings.set('client', 'audioSrc', 'mic-2');
    await until(() => gum().mock.calls.length === 2);
    await flush(20);

    expect(gum().mock.calls[1]?.[0].audio).toEqual({ deviceId: { ideal: 'mic-2' } });
    expect(oldTrack?.readyState).toBe('ended');
    expect(core.getProducer('mic')).toBe(producer);
    expect(producer?.track).toBe(client.localStream?.getAudioTracks()[0]);
    expect(producer?.track).not.toBe(oldTrack);
    expect(sfu.requests('produce')).toHaveLength(producesBefore);
    // Voice detection is re-armed on the new levels stream.
    expect(master._initializeUserVoiceDetection).toHaveBeenLastCalledWith('ptt');
  });

  it('turning the microphone off closes the mic producer and tells the server', async () => {
    const { master, settings } = av({ settings: { voiceMode: 'always' } });
    await master.connect();
    await flush(20);
    const micId = localProducer('audio')?.id;
    settings.set('client', 'audioSrc', 'disabled');
    await until(() => sfu.requests('closeProducer').length === 1);
    expect(sfu.requests('closeProducer')[0]?.producerId).toBe(micId);
    expect(gum().mock.calls[1]?.[0].audio).toBe(false);
    expect(localProducer('audio')).toBeUndefined();
    expect(localProducer('video')).toBeDefined();
  });

  it('respects the world A/V mode: video-only never opens the microphone', async () => {
    const { master } = av({ settings: { mode: AVSettings.AV_MODES.VIDEO } });
    expect(await master.connect()).toBe(true);
    await flush(20);
    expect(gum().mock.calls[0]?.[0].audio).toBe(false);
    expect(localProducer('audio')).toBeUndefined();
    expect(localProducer('video')).toBeDefined();
  });

  it('tells the other users its audio/video state after connecting', async () => {
    const { master } = av({ settings: { voiceMode: 'always' } });
    const user = env.game.user;
    user.broadcastActivity.mockClear();
    await master.connect();
    expect(user.broadcastActivity).toHaveBeenCalledWith({ av: { muted: false, hidden: false } });
  });
});

describe('remote users', () => {
  it("a remote user's tracks become one MediaStream for the camera views", async () => {
    const { master, client } = av();
    await master.connect();
    const remote = await remotePeer();
    await remote.startLocalAudio(audioTrack());
    await remote.startLocalVideo(videoTrack());
    await until(
      () => (client.getMediaStreamForUser(REMOTE_USER_ID)?.getTracks().length ?? 0) === 2,
    );

    const stream = client.getMediaStreamForUser(REMOTE_USER_ID);
    expect(stream?.getAudioTracks()).toHaveLength(1);
    expect(stream?.getAudioTracks()[0]?.readyState).toBe('live');
    expect(stream?.getVideoTracks()).toHaveLength(1);
    expect(client.getLevelsStreamForUser(REMOTE_USER_ID)?.getAudioTracks()).toHaveLength(1);
    expect(client.getConnectedUsers().sort()).toEqual([LOCAL_USER_ID, REMOTE_USER_ID]);
  });

  it('re-renders through AVMaster#render when remote tracks arrive', async () => {
    const { master } = av();
    expect(master.render).toBeTypeOf('function');
    await master.connect();
    master.render?.mockClear();
    const remote = await remotePeer();
    await remote.startLocalAudio(audioTrack());
    await until(() => (master.render?.mock.calls.length ?? 0) > 0);
  });

  it('defensive fallback: re-renders through ui.webrtc when a master lacks render()', async () => {
    const { master } = av({ master: { omitRender: true } });
    expect(master.render).toBeUndefined();
    await master.connect();
    env.cameraViews.render.mockClear();
    const remote = await remotePeer();
    await remote.startLocalAudio(audioTrack());
    await until(() => env.cameraViews.render.mock.calls.length > 0);
  });

  it('"mute all" and the output device, changed through AVSettings, re-render and reach the remote tile', async () => {
    const { master, client, settings } = av();
    await master.connect();
    const remote = await remotePeer();
    await remote.startLocalAudio(audioTrack());
    await until(() => client.getMediaStreamForUser(REMOTE_USER_ID) !== null);

    const video = document.createElement('video');
    const setSinkId = vi.fn(async (id: string) => {
      Object.defineProperty(video, 'sinkId', { configurable: true, value: id });
    });
    Object.defineProperty(video, 'sinkId', { configurable: true, value: '' });
    Object.defineProperty(video, 'setSinkId', { configurable: true, value: setSinkId });
    env.cameraViews.videos.set(REMOTE_USER_ID, video);
    await client.setUserVideo(REMOTE_USER_ID, video);
    expect(video.muted).toBe(false);
    setSinkId.mockClear();

    // The AVMaster double only forwards the change: the client must
    // re-render for these itself.
    settings.set('client', 'muteAll', true);
    await until(() => video.muted === true);
    settings.set('client', 'muteAll', false);
    await until(() => video.muted === false);

    settings.set('client', 'audioSink', 'speaker-2');
    await until(() => setSinkId.mock.calls.length > 0);
    expect(setSinkId).toHaveBeenCalledTimes(1);
    expect(setSinkId).toHaveBeenCalledWith('speaker-2');
    // Already routed there: no second setSinkId on the next render.
    await client.setUserVideo(REMOTE_USER_ID, video);
    expect(setSinkId).toHaveBeenCalledTimes(1);
  });

  it('setUserVideo attaches the stream, mutes local playback, honours muteAll and marks paused remote video', async () => {
    const { master, client, settings } = av();
    await master.connect();
    const remote = await remotePeer();
    await remote.startLocalVideo(videoTrack(), { paused: true });
    await until(() => client.getMediaStreamForUser(REMOTE_USER_ID) !== null);

    const remoteVideo = document.createElement('video');
    await client.setUserVideo(REMOTE_USER_ID, remoteVideo);
    expect(remoteVideo.srcObject).toBe(client.getMediaStreamForUser(REMOTE_USER_ID));
    expect(remoteVideo.muted).toBe(false);
    expect(remoteVideo.dataset.mediasoupVideoPaused).toBe('true');

    settings.client.muteAll = true;
    await client.setUserVideo(REMOTE_USER_ID, remoteVideo);
    expect(remoteVideo.muted).toBe(true);

    const localVideo = document.createElement('video');
    await client.setUserVideo(LOCAL_USER_ID, localVideo);
    expect(localVideo.srcObject).toBe(client.localStream);
    expect(localVideo.muted).toBe(true);
  });

  it('producerResumed clears the paused marker on the rendered tile without replacing the stream', async () => {
    const { master, client } = av();
    await master.connect();
    const remote = await remotePeer();
    await remote.startLocalVideo(videoTrack(), { paused: true });
    await until(() => client.getMediaStreamForUser(REMOTE_USER_ID) !== null);
    const video = document.createElement('video');
    await client.setUserVideo(REMOTE_USER_ID, video);
    env.cameraViews.videos.set(REMOTE_USER_ID, video);
    const stream = client.getMediaStreamForUser(REMOTE_USER_ID);

    remote.resumeProducer('webcam');
    await until(() => video.dataset.mediasoupVideoPaused === undefined);
    expect(client.isRemoteProducerPaused(REMOTE_USER_ID, 'video')).toBe(false);
    expect(client.getMediaStreamForUser(REMOTE_USER_ID)).toBe(stream);
    env.cameraViews.videos.clear();
  });

  it('a closed remote producer removes that user from the streams', async () => {
    const { master, client } = av();
    await master.connect();
    const remote = await remotePeer();
    await remote.startLocalAudio(audioTrack());
    await until(() => client.getMediaStreamForUser(REMOTE_USER_ID) !== null);
    remote.stopLocalAudio(true);
    await until(() => client.getMediaStreamForUser(REMOTE_USER_ID) === null);
    expect(client.getLevelsStreamForUser(REMOTE_USER_ID)).toBeNull();
  });
});

describe('voice mode changes mid-session', () => {
  it('ptt -> always -> activity -> ptt re-arms the broadcast, the speaking state and voice detection', async () => {
    const { master, client, settings } = av({ settings: { voiceMode: 'ptt' } });
    await master.connect();
    await flush(20);
    expect(localProducer('audio')?.paused).toBe(true);
    expect(master.broadcasting).toBe(false);
    const lastMode = () => master._initializeUserVoiceDetection.mock.lastCall?.[0];

    // ptt -> always: live at once; the client asks AVMaster to broadcast and
    // restarts voice detection for the new mode.
    master.broadcast.mockClear();
    master._initializeUserVoiceDetection.mockClear();
    settings.set('client', 'voice.mode', 'always');
    await until(() => localProducer('audio')?.paused === false);
    expect(master.broadcast).toHaveBeenLastCalledWith(true);
    expect(master.broadcasting).toBe(true);
    expect(lastMode()).toBe('always');
    // Restarting detection clears the speaking indicator; the client must
    // set it back to the broadcast state.
    expect(env.cameraViews.speaking.get(LOCAL_USER_ID)).toBe(true);

    // always -> activity: paused until speech, and detection listens on the
    // client's levels stream, whose track stays enabled while paused.
    master.broadcast.mockClear();
    env.audio.startLevelReports.mockClear();
    settings.set('client', 'voice.mode', 'activity');
    await until(() => localProducer('audio')?.paused === true);
    expect(master.broadcast).toHaveBeenLastCalledWith(false);
    expect(master.broadcasting).toBe(false);
    expect(lastMode()).toBe('activity');
    expect(env.cameraViews.speaking.get(LOCAL_USER_ID)).toBe(false);
    const [id, stream] = env.audio.startLevelReports.mock.lastCall ?? [];
    expect(id).toBe(LOCAL_USER_ID);
    expect(stream).toBe(client.getLevelsStreamForUser(LOCAL_USER_ID));
    expect(stream?.getAudioTracks().some((t: MediaStreamTrack) => t.enabled)).toBe(true);

    // The double's level handler (a plain threshold) turns the broadcast on
    // and off; the client follows through toggleBroadcast.
    const handler = env.audio.levelHandlers.get(LOCAL_USER_ID);
    expect(handler).toBeTypeOf('function');
    handler?.(VOICE_THRESHOLD_DB + 30);
    await until(() => localProducer('audio')?.paused === false);
    expect(localTrack(client, 'audio')?.enabled).toBe(true);
    handler?.(VOICE_THRESHOLD_DB - 40);
    await until(() => localProducer('audio')?.paused === true);
    expect(localTrack(client, 'audio')?.enabled).toBe(false);

    // activity -> ptt: silent until the key (AVMaster#broadcast) is pressed.
    settings.set('client', 'voice.mode', 'ptt');
    await until(() => lastMode() === 'ptt');
    expect(localProducer('audio')?.paused).toBe(true);
    master.broadcast(true);
    await until(() => localProducer('audio')?.paused === false);
    master.broadcast(false);
    await until(() => localProducer('audio')?.paused === true);
  });
});

describe('failures and teardown', () => {
  it('a transport-creation failure leaves the client disconnected and never opens the camera or microphone', async () => {
    sfu.override({ type: 'createWebRtcTransport', error: 'no transport' });
    const { master, client } = av();
    expect(await master.connect()).toBe(false);
    expect(client.isConnected).toBe(false);
    expect(gum()).not.toHaveBeenCalled();
    expect(client.localStream).toBeNull();
    expect(env.notifications.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not connect to the MediaSoup server: no transport'),
      undefined,
    );
    await flush(80);
    expect(sfu.sockets).toHaveLength(1);
  });

  it('a wrong server URL scheme is refused before any socket opens', async () => {
    const { master } = av({ serverUrl: 'https://sfu.test' });
    expect(await master.connect()).toBe(false);
    expect(sfu.sockets).toHaveLength(0);
    expect(env.notifications.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid server URL protocol https:'),
      undefined,
    );
  });

  it('disconnect releases the devices, drops remote streams and reports the disconnection', async () => {
    const { master, client } = av();
    await master.connect();
    const remote = await remotePeer();
    await remote.startLocalAudio(audioTrack());
    await until(() => client.getMediaStreamForUser(REMOTE_USER_ID) !== null);
    const tracks = client.localStream?.getTracks() ?? [];
    expect(tracks.length).toBe(2);

    expect(await master.disconnect()).toBe(true);
    expect(tracks.every((t) => t.readyState === 'ended')).toBe(true);
    expect(client.localStream).toBeNull();
    expect(client.getMediaStreamForUser(REMOTE_USER_ID)).toBeNull();
    expect(client.getConnectedUsers()).toEqual([LOCAL_USER_ID]);
    expect(sfu.producersOf(LOCAL_USER_ID)).toHaveLength(0);
    expect(await client.disconnect()).toBe(false);
  });

  it('recovers from a signaling loss by itself, without AVMaster#reestablish', async () => {
    const { master, client } = av({ settings: { voiceMode: 'always' } });
    await master.connect();
    await flush(20);
    sfu.sockets[0]?.serverClose(1006);
    await until(() => env.notifications.warn.mock.calls.length > 0);
    await until(() => client.isConnected && sfu.producersOf(LOCAL_USER_ID).length === 2);
    expect(master.reestablish).not.toHaveBeenCalled();
    expect(env.notifications.info).toHaveBeenCalledWith(
      expect.stringContaining('Reconnected to the MediaSoup server.'),
      undefined,
    );
  });
});
