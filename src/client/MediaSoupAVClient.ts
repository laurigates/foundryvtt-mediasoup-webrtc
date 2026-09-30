/**
 * MediaSoupAVClient: the Foundry AVClient backed by a MediaSoup SFU.
 *
 * Registered as `CONFIG.WebRTC.clientClass` by the module entry. Core AVMaster
 * (`game.webrtc`) owns the lifecycle (initialize, connect, reestablish), core
 * CameraViews renders the dock, and core AVSettings holds devices, mute state
 * and the voice mode. This class only maps those onto the transport core in
 * `MediaSoupVTTClient`.
 *
 * Signatures follow the v14 foundry.av.AVClient API page (14.368); they are
 * the same in v13.
 */

import {
  APP_DATA_TAG_MIC,
  APP_DATA_TAG_WEBCAM,
  MODULE_ID,
  MODULE_TITLE,
  type MediaTag,
  SETTING_MEDIASOUP_AUTH_TOKEN,
  SETTING_MEDIASOUP_URL,
} from '../constants/index.js';
import { log } from '../utils/logger.js';
import {
  type LocalTrackEnded,
  MediaSoupVTTClient,
  type RemoteTrackInfo,
  type StateChange,
  validateServerUrl,
} from './MediaSoupVTTClient.js';

/** Value of `client.audioSrc` / `client.videoSrc` that turns a device off. */
const DISABLED_SOURCE = 'disabled';

/**
 * AVSettings paths that only change how the dock shows existing streams
 * (output device, "mute all", video off, nameplates): a re-render applies them.
 */
const DOCK_DISPLAY_PATHS = new Set([
  'client.audioSink',
  'client.muteAll',
  'client.disableVideo',
  'client.nameplates',
]);

/** Ideal capture size for the camera. The dock shows small tiles. */
const VIDEO_IDEAL_WIDTH = 640;
const VIDEO_IDEAL_HEIGHT = 480;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Collect the dotted key paths of a (possibly nested) changes object, the way
 * `foundry.utils.flattenObject` would. Kept local so it runs without Foundry.
 */
export function changedKeys(changed: object, prefix = ''): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(changed ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = changedKeys(value, path);
      if (nested.size === 0) keys.add(path);
      for (const k of nested) keys.add(k);
    } else {
      keys.add(path);
    }
  }
  return keys;
}

/** Build getUserMedia constraints for one device setting. */
export function deviceConstraint(
  source: unknown,
  allowed: boolean,
  extra: MediaTrackConstraints = {},
): MediaTrackConstraints | false {
  if (!allowed || source === DISABLED_SOURCE) return false;
  if (typeof source !== 'string' || !source || source === 'default') {
    return { ...extra };
  }
  return { ...extra, deviceId: { ideal: source } };
}

function localizeOr(key: string, fallback: string): string {
  const i18n = typeof game !== 'undefined' ? game.i18n : undefined;
  if (i18n?.has?.(key)) return i18n.localize(key);
  return fallback;
}

/** Like {@link localizeOr}, filling `{name}` placeholders from `data`. */
function formatOr(key: string, fallback: string, data: Record<string, string>): string {
  const i18n = typeof game !== 'undefined' ? game.i18n : undefined;
  if (i18n?.has?.(key)) return i18n.format(key, data);
  return fallback.replace(/\{(\w+)\}/g, (match, name: string) => data[name] ?? match);
}

function notify(level: 'info' | 'warn' | 'error', message: string, permanent = false): void {
  if (typeof ui === 'undefined' || !ui.notifications) return;
  ui.notifications[level](`${MODULE_TITLE}: ${message}`, permanent ? { permanent } : undefined);
}

export class MediaSoupAVClient extends foundry.av.AVClient {
  /** The SFU transport core. */
  readonly transport: MediaSoupVTTClient;

  /** The captured local audio and video tracks. */
  localStream: MediaStream | null = null;

  /**
   * A dedicated audio stream for voice-level detection. It holds a clone of
   * the microphone track, so pausing the producer (which disables the sent
   * track) does not silence voice activation.
   */
  levelsStream: MediaStream | null = null;

  /** Is outbound broadcast of local audio enabled (voice mode + mute)? */
  audioBroadcastEnabled = false;

  /** Is outbound video enabled (not hidden)? */
  videoBroadcastEnabled = false;

  /** userId -> MediaStream of that user's consumed tracks. */
  readonly remoteStreams = new Map<string, MediaStream>();

  /** userId -> audio-only MediaStream for level monitoring. */
  readonly #remoteLevelsStreams = new Map<string, MediaStream>();

  #renderQueued = false;
  #disconnecting = false;
  /** Set once {@link initialize} has run; AVMaster calls it before every connect. */
  #initialized = false;
  /**
   * Bumped by every capture and by disconnect, so a getUserMedia call that
   * resolves after it was superseded releases its tracks instead of keeping them.
   */
  #captureGeneration = 0;
  /** Bumped by disconnect, so a connect it superseded stays quiet. */
  #connectGeneration = 0;
  readonly #unsubscribe: Array<() => void> = [];

  constructor(master: AVMaster, settings: AVSettings, transport?: MediaSoupVTTClient) {
    super(master, settings);
    this.transport = transport ?? new MediaSoupVTTClient();
    this.#unsubscribe.push(
      this.transport.on('consumerAdded', (info) => this.#onRemoteTrackChanged(info)),
      this.transport.on('consumerUpdated', (info) => this.#onRemoteTrackUpdated(info)),
      this.transport.on('consumerRemoved', (info) => this.#onRemoteTrackChanged(info)),
      this.transport.on('stateChanged', (change) => this.#onTransportStateChanged(change)),
      this.transport.on('localTrackEnded', (ended) => this.#onLocalTrackEnded(ended)),
    );
    if (typeof Hooks !== 'undefined' && typeof Hooks.on === 'function') {
      const hookId = Hooks.on('userConnected', (user: { id?: string }, connected: boolean) =>
        this.#onUserConnected(user, connected),
      );
      this.#unsubscribe.push(() => Hooks.off('userConnected', hookId));
    }
  }

  /** Whether the SFU connection is up (read by the Settings page status). */
  get isConnected(): boolean {
    return this.transport.isConnected;
  }

  get isConnecting(): boolean {
    return this.transport.isConnecting;
  }

  get #userId(): string {
    return game.user?.id ?? game.userId ?? '';
  }

  // ==== Connection ====

  /**
   * Called by AVMaster before every connect; only the first call does work.
   * Creates the mediasoup Device, which detects the browser's WebRTC handler.
   * The Device is loaded with the router's capabilities in {@link connect}.
   */
  override async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    try {
      const handler = this.transport.prepareDevice();
      log(`mediasoup-client Device ready (handler: ${handler}).`, 'info');
    } catch (error) {
      log(`This browser cannot run mediasoup-client: ${errorMessage(error)}`, 'error', true);
      notify(
        'error',
        formatOr(
          'MEDIASOUPVTT.Notifications.BrowserUnsupported',
          'This browser cannot run MediaSoup audio/video: {error}',
          { error: errorMessage(error) },
        ),
        true,
      );
    }
  }

  /**
   * Connect to the SFU with the module's server URL and token, then capture
   * local media from the AVSettings devices and start producing.
   */
  override async connect(): Promise<boolean> {
    const serverUrl = String(game.settings.get(MODULE_ID, SETTING_MEDIASOUP_URL) ?? '');
    const authToken = String(game.settings.get(MODULE_ID, SETTING_MEDIASOUP_AUTH_TOKEN) ?? '');

    try {
      validateServerUrl(serverUrl);
    } catch (error) {
      log(errorMessage(error), 'warn', true);
      if (!serverUrl) {
        notify(
          'warn',
          localizeOr(
            'MEDIASOUPVTT.Notifications.ServerUrlNotSet',
            'MediaSoup server URL not configured. Please set it in module settings.',
          ),
        );
      } else {
        notify('error', errorMessage(error));
      }
      return false;
    }

    const params = { serverUrl, authToken, userId: this.#userId, roomId: game.world?.id };
    const transport = this.transport;
    const paramsChanged =
      transport.serverUrl !== params.serverUrl ||
      transport.authToken !== params.authToken ||
      transport.userId !== params.userId ||
      transport.roomId !== params.roomId;
    if (paramsChanged && (transport.isConnected || transport.isConnecting)) {
      // Do not rely on AVMaster disconnecting first: a live connection to the
      // old server, token or room would otherwise be reused as is.
      log('MediaSoup connection parameters changed; reconnecting.', 'info');
      this.#disconnectTransport();
    }
    transport.configure(params);

    const generation = this.#connectGeneration;
    try {
      await transport.connect();
    } catch (error) {
      // Superseded by a disconnect (AVMaster disconnects before it connects
      // again); the newer connect reports its own outcome.
      if (generation !== this.#connectGeneration) return false;
      log(`Could not connect to the MediaSoup server: ${errorMessage(error)}`, 'error', true);
      notify(
        'error',
        formatOr(
          'MEDIASOUPVTT.Notifications.ConnectionError',
          'Could not connect to the MediaSoup server: {error}',
          { error: errorMessage(error) },
        ),
      );
      return false;
    }
    if (generation !== this.#connectGeneration) return false;

    // A capture superseded by a concurrent updateLocalStream is produced by it.
    const captured = await this.#initializeLocalStream();
    if (generation !== this.#connectGeneration) return false;
    if (captured) await this.#produceLocalTracks();
    if (generation !== this.#connectGeneration) return false;
    this.#broadcastActivity();
    this.render();
    return true;
  }

  /** Close the SFU connection and release the camera and microphone. */
  override async disconnect(): Promise<boolean> {
    const wasConnected = this.transport.isConnected || this.transport.isConnecting;
    this.#disconnectTransport();
    this.#stopLocalStream();
    this.remoteStreams.clear();
    this.#remoteLevelsStreams.clear();
    this.render();
    return wasConnected;
  }

  // ==== Device discovery ====

  override async getAudioSinks(): Promise<Record<string, string>> {
    return this.#getSourcesOfType('audiooutput');
  }

  override async getAudioSources(): Promise<Record<string, string>> {
    return this.#getSourcesOfType('audioinput');
  }

  override async getVideoSources(): Promise<Record<string, string>> {
    return this.#getSourcesOfType('videoinput');
  }

  async #getSourcesOfType(kind: MediaDeviceKind): Promise<Record<string, string>> {
    if (!navigator.mediaDevices?.enumerateDevices) return {};
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const unknown = localizeOr('WEBRTC.UnknownDevice', 'Unknown device');
      const sources: Record<string, string> = {};
      for (const device of devices) {
        if (device.kind === kind) sources[device.deviceId] = device.label || unknown;
      }
      return sources;
    } catch (error) {
      log(`Could not list ${kind} devices: ${errorMessage(error)}`, 'warn');
      return {};
    }
  }

  // ==== Track manipulation ====

  /**
   * The local user plus, while connected to the SFU, every other active
   * Foundry user, matching the default client's dock (a tile per active
   * user). A peer that sends no media still gets a tile (avatar, nameplate,
   * GM controls). Only active users are listed: CameraViews cannot render a
   * tile for an inactive or unknown user id.
   */
  override getConnectedUsers(): string[] {
    const users = new Set<string>();
    const self = this.#userId;
    if (self) users.add(self);
    if (!this.transport.isConnected && !this.transport.isReconnecting) return [...users];
    const gameUsers = typeof game !== 'undefined' ? game.users : undefined;
    for (const user of gameUsers ?? []) {
      if (user?.active && user.id) users.add(user.id);
    }
    for (const userId of this.transport.getRemoteUserIds()) {
      if (gameUsers?.get?.(userId)?.active) users.add(userId);
    }
    return [...users];
  }

  override getMediaStreamForUser(userId: string): MediaStream | null {
    if (userId === this.#userId) return this.localStream;
    return this.remoteStreams.get(userId) ?? null;
  }

  override getLevelsStreamForUser(userId: string): MediaStream | null {
    if (userId === this.#userId) return this.levelsStream;
    const cached = this.#remoteLevelsStreams.get(userId);
    if (cached) return cached;
    const audio = this.transport.getRemoteTracks(userId).audio;
    if (!audio) return null;
    const stream = new MediaStream([audio]);
    this.#remoteLevelsStreams.set(userId, stream);
    return stream;
  }

  /** Is there a local audio track that can be sent? */
  override isAudioEnabled(): boolean {
    return (this.localStream?.getAudioTracks().length ?? 0) > 0;
  }

  /** Is there a local video track that can be sent? */
  override isVideoEnabled(): boolean {
    return (this.localStream?.getVideoTracks().length ?? 0) > 0;
  }

  /**
   * Mute or unmute the local microphone (the user muted themselves, or the GM
   * muted them). Muting always stops the broadcast. Unmuting resumes it at
   * once only in "always" mode; with push-to-talk or voice activation,
   * AVMaster turns the broadcast on through {@link toggleBroadcast}.
   */
  override toggleAudio(enable: boolean): void {
    log(`toggleAudio(${enable})`, 'debug');
    if (!enable) {
      this.toggleBroadcast(false);
      return;
    }
    if (this.isVoiceAlways) this.toggleBroadcast(true);
  }

  /**
   * Start or stop sending microphone audio. Called by AVMaster for
   * push-to-talk and voice activation. A muted user never broadcasts.
   */
  override toggleBroadcast(broadcast: boolean): void {
    const allowed = broadcast && this.#canShareAudio();
    log(`toggleBroadcast(${broadcast}) -> ${allowed}`, 'debug');
    this.audioBroadcastEnabled = allowed;
    this.#applyAudioState();
  }

  /** Show or hide the local camera (hidden by the user or the GM). */
  override toggleVideo(enable: boolean): void {
    const allowed = enable && this.#canShareVideo();
    log(`toggleVideo(${enable}) -> ${allowed}`, 'debug');
    this.videoBroadcastEnabled = allowed;
    this.#applyVideoState();
    this.render();
  }

  /**
   * Attach a user's stream to a CameraViews video element. The element plays
   * the remote audio too, so it is routed to the configured output device.
   */
  override async setUserVideo(userId: string, videoElement: HTMLVideoElement): Promise<void> {
    if (!videoElement) return;
    const stream = this.getMediaStreamForUser(userId);
    if (videoElement.srcObject !== stream) videoElement.srcObject = stream;

    if (userId === this.#userId) {
      // Never play the local microphone back.
      videoElement.muted = true;
      return;
    }
    // Core's camera template does not apply "mute all" to remote users.
    videoElement.muted = this.settings.get('client', 'muteAll') === true;
    if (!stream) return;
    this.#markRemotePaused(userId, videoElement);
    const sink = this.settings.get('client', 'audioSink');
    const element = videoElement as HTMLVideoElement & {
      sinkId?: string;
      setSinkId?: (id: string) => Promise<void>;
    };
    if (typeof element.setSinkId !== 'function') {
      log('This browser does not support choosing the audio output device.', 'debug');
      return;
    }
    if (typeof sink !== 'string' || !sink || element.sinkId === sink) return;
    try {
      await element.setSinkId(sink);
    } catch (error) {
      log(`Could not set audio output device ${sink}: ${errorMessage(error)}`, 'warn');
    }
  }

  /**
   * Whether a remote user's producer of this kind is paused (push-to-talk
   * released, muted, camera hidden), as the server last reported it.
   */
  isRemoteProducerPaused(userId: string, kind: 'audio' | 'video'): boolean {
    return this.transport.getRemoteTrackInfo(userId)[kind]?.producerPaused === true;
  }

  /**
   * Expose the remote pause state on the camera view's video element as
   * `data-mediasoup-audio-paused` / `data-mediasoup-video-paused`, so the
   * view can show a paused remote stream instead of a frozen frame.
   */
  #markRemotePaused(userId: string, videoElement: HTMLVideoElement): void {
    const dataset = videoElement.dataset;
    if (!dataset) return;
    for (const kind of ['audio', 'video'] as const) {
      const key = kind === 'audio' ? 'mediasoupAudioPaused' : 'mediasoupVideoPaused';
      if (this.isRemoteProducerPaused(userId, kind)) dataset[key] = 'true';
      else delete dataset[key];
    }
  }

  // ==== Settings and configuration ====

  /** React to AVSettings changes (devices, voice mode, mute, output). */
  override onSettingsChanged(changed: object): void {
    const keys = changedKeys(changed);
    const self = this.#userId;

    const sourceChange = keys.has('client.audioSrc') || keys.has('client.videoSrc');
    if (sourceChange) {
      this.updateLocalStream().catch((error: unknown) =>
        log(`Could not switch devices: ${errorMessage(error)}`, 'error'),
      );
    }

    const modeChange =
      keys.has('client.voice.mode') ||
      [...keys].some((k) => k === `client.users.${self}.muted` || k === `client.users.${self}`);
    if (modeChange) {
      const mode = this.settings.client?.voice?.mode ?? 'ptt';
      const isAlways = mode === 'always';
      this.toggleAudio(isAlways && this.#canShareAudio());
      this.master.broadcast(isAlways);
      // AVMaster starts voice detection only after connect; a switch to (or
      // from) voice activation must restart (or stop) the level reports.
      // Pass the current mode: `changed` lacks it when only `muted` changed.
      this.#restartVoiceDetection(mode);
    }

    const hiddenChange = [...keys].some(
      (k) => k === `client.users.${self}.hidden` || k === `client.users.${self}`,
    );
    if (hiddenChange) this.toggleVideo(this.#canShareVideo());

    // New devices mean new tracks in the tiles; display settings need a redraw.
    let redraw = sourceChange;
    for (const path of DOCK_DISPLAY_PATHS) redraw ||= keys.has(path);
    if (redraw) this.render();
  }

  /**
   * Re-capture local media with the current AVSettings devices and swap the
   * new tracks into the existing producers.
   */
  override async updateLocalStream(): Promise<void> {
    // Releases the old devices first; some browsers cannot open a camera twice.
    if (!(await this.#initializeLocalStream())) return;
    // While reconnecting the core records the tracks and sends them once the
    // connection is back.
    if (this.transport.isConnected || this.transport.isReconnecting) {
      await this.#produceLocalTracks();
      this.#broadcastActivity();
    }

    // Voice detection holds the old levels stream; re-read it.
    this.#restartVoiceDetection(this.settings.client?.voice?.mode ?? 'ptt');
    this.render();
  }

  /**
   * Restart core voice detection for `mode`. Restarting detection clears the
   * local speaking indicator, so set it back to the current broadcast state.
   */
  #restartVoiceDetection(mode: string): void {
    this.master._initializeUserVoiceDetection?.(mode);
    const views = typeof ui !== 'undefined' ? ui.webrtc : undefined;
    views?.setUserIsSpeaking?.(this.#userId, this.master.broadcasting === true);
  }

  // ==== Rendering ====

  /**
   * Re-render the camera views, coalescing bursts of track changes into one
   * render. Uses AVMaster#render (core v13 and v14.368 both define it) and,
   * defensively, falls back to ui.webrtc (CameraViews).
   */
  render(): void {
    if (this.#renderQueued) return;
    this.#renderQueued = true;
    queueMicrotask(() => {
      this.#renderQueued = false;
      try {
        if (typeof this.master?.render === 'function') this.master.render();
        else ui?.webrtc?.render?.();
      } catch (error) {
        log(`Camera view render failed: ${errorMessage(error)}`, 'warn');
      }
    });
  }

  // ==== Internals ====

  #canShareAudio(): boolean {
    const self = this.#userId;
    return typeof this.master?.canUserShareAudio === 'function'
      ? this.master.canUserShareAudio(self)
      : !this.isMuted;
  }

  #canShareVideo(): boolean {
    const self = this.#userId;
    return typeof this.master?.canUserShareVideo === 'function'
      ? this.master.canUserShareVideo(self)
      : true;
  }

  /**
   * Capture local audio/video as the AV mode, permissions and devices allow.
   * Returns false when a later capture or a disconnect superseded this one
   * while getUserMedia was pending; its tracks are then stopped.
   */
  async #initializeLocalStream(): Promise<boolean> {
    this.#stopLocalStream();
    const capture = ++this.#captureGeneration;
    const self = this.#userId;
    const client = this.settings.client;
    const audio = deviceConstraint(client?.audioSrc, this.master.canUserBroadcastAudio(self));
    const video = deviceConstraint(client?.videoSrc, this.master.canUserBroadcastVideo(self), {
      width: { ideal: VIDEO_IDEAL_WIDTH },
      height: { ideal: VIDEO_IDEAL_HEIGHT },
    });
    if (!audio && !video) {
      log('Local media disabled by the A/V mode, permissions or device settings.', 'info');
      return true;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      log('navigator.mediaDevices.getUserMedia is unavailable (insecure context?).', 'error', true);
      return true;
    }

    // Try both, then each alone, so one missing device does not block the other.
    const attempts: MediaStreamConstraints[] = [{ audio, video }];
    if (audio && video) attempts.push({ audio, video: false }, { audio: false, video });
    let lastError: unknown;
    let stream: MediaStream | null = null;
    for (const constraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        lastError = error;
        log(`getUserMedia(${JSON.stringify(constraints)}) failed: ${errorMessage(error)}`, 'warn');
      }
      if (capture !== this.#captureGeneration) {
        for (const track of stream?.getTracks() ?? []) track.stop();
        log('Local media capture superseded; released its tracks.', 'debug');
        return false;
      }
      if (stream) break;
    }
    if (!stream) {
      notify(
        'warn',
        formatOr(
          'MEDIASOUPVTT.Notifications.MediaAccessFailed',
          'Could not access your camera or microphone: {error}',
          { error: errorMessage(lastError) },
        ),
      );
      return true;
    }
    this.localStream = stream;

    const audioTrack = stream.getAudioTracks()[0];
    this.levelsStream = audioTrack ? new MediaStream([audioTrack.clone()]) : null;

    this.audioBroadcastEnabled = this.isVoiceAlways && this.#canShareAudio();
    this.videoBroadcastEnabled = this.#canShareVideo();
    this.#applyAudioState();
    this.#applyVideoState();
    return true;
  }

  /** Produce (or swap into existing producers) the current local tracks. */
  async #produceLocalTracks(): Promise<void> {
    const audioTrack = this.localStream?.getAudioTracks()[0];
    const videoTrack = this.localStream?.getVideoTracks()[0];
    await this.#produceOrClose(APP_DATA_TAG_MIC, audioTrack, !this.audioBroadcastEnabled);
    await this.#produceOrClose(APP_DATA_TAG_WEBCAM, videoTrack, !this.videoBroadcastEnabled);
  }

  async #produceOrClose(
    tag: MediaTag,
    track: MediaStreamTrack | undefined,
    paused: boolean,
  ): Promise<void> {
    if (!track) {
      // No device (or the mode forbids it): stop sending and tell the server,
      // so the other peers drop the consumer.
      this.transport.closeProducer(tag, true);
      return;
    }
    try {
      await this.transport.produce(tag, track, { paused });
    } catch (error) {
      log(`Could not send ${tag}: ${errorMessage(error)}`, 'error', true);
    }
  }

  /** Enable or pause the outgoing microphone to match the broadcast state. */
  #applyAudioState(): void {
    const send = this.audioBroadcastEnabled;
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = send;
    if (send) this.transport.resumeProducer(APP_DATA_TAG_MIC);
    else this.transport.pauseProducer(APP_DATA_TAG_MIC);
  }

  /** Enable or pause the outgoing camera to match the hidden state. */
  #applyVideoState(): void {
    const send = this.videoBroadcastEnabled;
    for (const track of this.localStream?.getVideoTracks() ?? []) track.enabled = send;
    if (send) this.transport.resumeProducer(APP_DATA_TAG_WEBCAM);
    else this.transport.pauseProducer(APP_DATA_TAG_WEBCAM);
  }

  /** Disconnect the transport core without reporting it as a connection loss. */
  #disconnectTransport(): void {
    this.#connectGeneration++;
    // A capture still waiting on getUserMedia must not outlive the connection.
    this.#captureGeneration++;
    this.#disconnecting = true;
    try {
      this.transport.disconnect();
    } finally {
      this.#disconnecting = false;
    }
  }

  /**
   * Tell the other users whether this user's audio and video are live. Core
   * AVSettings broadcasts `{muted, hidden}` when AVMaster is created, before
   * any stream exists, so peers would otherwise keep showing this user as
   * muted and hidden.
   */
  #broadcastActivity(): void {
    const user = typeof game !== 'undefined' ? game.user : undefined;
    if (typeof user?.broadcastActivity !== 'function') return;
    const stored = this.settings.getUser?.(this.#userId);
    user.broadcastActivity({
      av: {
        muted: stored?.muted === true || !this.isAudioEnabled(),
        hidden: stored?.hidden === true || !this.isVideoEnabled(),
      },
    });
  }

  /** A user joined or left the world: update the tiles, and tell a newcomer our state. */
  #onUserConnected(user: { id?: string } | undefined, connected: boolean): void {
    if (!this.transport.isConnected && !this.transport.isReconnecting) return;
    if (connected && user?.id !== this.#userId) this.#broadcastActivity();
    this.render();
  }

  #stopLocalStream(): void {
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    for (const track of this.levelsStream?.getTracks() ?? []) track.stop();
    this.localStream = null;
    this.levelsStream = null;
  }

  /** A remote producer was paused or resumed: refresh that user's tile markers. */
  #onRemoteTrackUpdated({ userId }: RemoteTrackInfo): void {
    // Keep the MediaStream (a new one would make the tile re-attach and
    // flicker on every push-to-talk press); only the paused markers change.
    const views = typeof ui !== 'undefined' ? ui.webrtc : undefined;
    const video: HTMLVideoElement | null | undefined = views?.getUserVideoElement?.(userId);
    if (video) this.#markRemotePaused(userId, video);
    else this.render();
  }

  /** Rebuild a remote user's MediaStream after a consumer was added or removed. */
  #onRemoteTrackChanged({ userId }: RemoteTrackInfo): void {
    const { audio, video } = this.transport.getRemoteTracks(userId);
    const tracks = [audio, video].filter((t): t is MediaStreamTrack => !!t);
    this.#remoteLevelsStreams.delete(userId);
    // A new MediaStream object makes CameraViews re-attach it on render.
    if (tracks.length) this.remoteStreams.set(userId, new MediaStream(tracks));
    else this.remoteStreams.delete(userId);
    this.render();
  }

  /**
   * Follow the transport core's recovery. The core runs the only reconnect
   * loop (backoff with jitter, then a full re-join and re-produce), so this
   * only updates the views and tells the user; it does not call
   * AVMaster#reestablish.
   */
  #onTransportStateChanged({ state, previous, reason }: StateChange): void {
    if (this.#disconnecting) return;

    if (state === 'reconnecting' && previous === 'connected') {
      log(`Lost the MediaSoup connection: ${reason ?? 'unknown reason'}`, 'warn', true);
      notify(
        'warn',
        localizeOr('WEBRTC.ConnectionLostWarning', 'Connection lost. Trying to reconnect...'),
      );
      this.#clearRemoteStreams();
      return;
    }

    if (state === 'connected' && previous === 'reconnecting') {
      log('MediaSoup connection re-established.', 'info', true);
      this.#broadcastActivity();
      notify(
        'info',
        localizeOr(
          'MEDIASOUPVTT.Notifications.Reconnected',
          'Reconnected to the MediaSoup server.',
        ),
      );
      this.render();
      return;
    }

    if (state === 'failed' && (previous === 'reconnecting' || previous === 'connected')) {
      log(`MediaSoup connection failed: ${reason ?? 'unknown reason'}`, 'error', true);
      this.#clearRemoteStreams();
      if (previous === 'connected') {
        // The server replaced this connection (the same user joined elsewhere).
        notify(
          'warn',
          localizeOr(
            'MEDIASOUPVTT.Notifications.Replaced',
            'Audio/video moved to your newer session for this user.',
          ),
        );
      } else {
        notify(
          'error',
          formatOr(
            'MEDIASOUPVTT.Notifications.ReconnectFailed',
            'Could not reconnect to the MediaSoup server. {reason}',
            { reason: reason ?? '' },
          ).trim(),
          true,
        );
      }
    }
  }

  #clearRemoteStreams(): void {
    this.remoteStreams.clear();
    this.#remoteLevelsStreams.clear();
    this.render();
  }

  #onLocalTrackEnded({ tag }: LocalTrackEnded): void {
    // The device went away; recapture so another device (or none) takes over.
    log(`Local ${tag} track ended; recapturing local media.`, 'warn');
    this.updateLocalStream().catch((error: unknown) =>
      log(`Could not recapture local media: ${errorMessage(error)}`, 'error'),
    );
  }

  /** Detach from the transport core (for tests and teardown). */
  destroy(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.transport.disconnect();
    this.#stopLocalStream();
  }
}
