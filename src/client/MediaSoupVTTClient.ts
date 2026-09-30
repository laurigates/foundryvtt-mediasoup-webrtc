/**
 * MediaSoup transport core for MediaSoupVTT.
 *
 * Owns the WebSocket signaling channel, the mediasoup-client Device, the send
 * and receive transports, and the producers and consumers. It has no DOM or
 * Foundry UI access: it reports changes through typed events and the Foundry
 * AVClient (`MediaSoupAVClient`) turns them into camera views.
 *
 * Recovery is handled here, in one place:
 * - a transport whose ICE drops is repaired with an ICE restart
 *   (`restartIce`), and a transport that cannot be repaired triggers a full
 *   reconnect;
 * - an unexpected signaling loss starts a single backoff-with-jitter reconnect
 *   loop that redoes the whole join (auth, transports, `getProducers`) and
 *   re-produces the local tracks that were being sent.
 *
 * The WebSocket constructor and the Device factory are injectable so unit
 * tests can run the full signaling flow against fakes.
 */

import { Device } from 'mediasoup-client';
import type {
  Consumer,
  IceParameters,
  Device as MediasoupDevice,
  MediaKind,
  Producer,
  RtpCapabilities,
  Transport,
  ConnectionState as TransportConnectionState,
  TransportOptions,
} from 'mediasoup-client/types';
import {
  APP_DATA_TAG_MIC,
  APP_DATA_TAG_WEBCAM,
  CLOSE_CODE_REPLACED,
  CONNECTION_TIMEOUT_MS,
  ICE_DISCONNECTED_GRACE_MS,
  ICE_RESTART_MAX_ATTEMPTS,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
  type MediaTag,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  SIG_MSG_TYPES,
  SIGNALING_REQUEST_TIMEOUT_MS,
} from '../constants/index.js';
import { log } from '../utils/logger.js';
import { TypedEmitter } from './TypedEmitter.js';

// WebSocket readyState values. Spelled out so a fake WebSocket class does not
// need the static OPEN/CONNECTING constants.
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * Connection state of the transport core.
 *
 * - `connecting`: the first join (or one started by {@link MediaSoupVTTClient.connect}) is in flight.
 * - `reconnecting`: the connection was lost and the backoff loop is running.
 * - `failed`: the last attempt failed, the loop gave up, or the server replaced
 *   this connection. Nothing retries until `connect()` is called again.
 */
export type ClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export type TransportDirection = 'send' | 'recv';

/** A remote track, as announced by `consumerAdded` / `consumerUpdated` / `consumerRemoved`. */
export interface RemoteTrackInfo {
  userId: string;
  kind: MediaKind;
  track: MediaStreamTrack;
  consumerId: string;
  producerId: string;
  /**
   * Whether the remote producer is paused: taken from the consume response's
   * `producerPaused`, then kept current by the server's `producerPaused` /
   * `producerResumed` notifications (each announced with `consumerUpdated`).
   */
  producerPaused: boolean;
}

export interface StateChange {
  state: ClientState;
  previous: ClientState;
  /** Why the state changed, when it was not requested (for example a socket close). */
  reason?: string;
}

export interface TransportStateChange {
  direction: TransportDirection;
  state: TransportConnectionState;
}

export interface LocalTrackEnded {
  tag: MediaTag;
  kind: MediaKind;
}

export interface ReconnectScheduled {
  /** 1-based number of the attempt that will run after `delayMs`. */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export interface IceRestartStarted {
  direction: TransportDirection;
  /** 1-based restart attempt since the transport was last connected. */
  attempt: number;
}

/** Events emitted by {@link MediaSoupVTTClient}. */
export interface MediaSoupVTTClientEvents {
  consumerAdded: RemoteTrackInfo;
  /** A consumed track's metadata changed (for example `producerPaused`). */
  consumerUpdated: RemoteTrackInfo;
  consumerRemoved: RemoteTrackInfo;
  stateChanged: StateChange;
  transportStateChanged: TransportStateChange;
  localTrackEnded: LocalTrackEnded;
  reconnecting: ReconnectScheduled;
  iceRestart: IceRestartStarted;
}

/** The subset of the WebSocket constructor the core uses. */
export type WebSocketConstructor = new (url: string) => WebSocket;

/** Creates an unloaded mediasoup-client Device. */
export type DeviceFactory = () => MediasoupDevice;

export interface ReconnectPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export interface IcePolicy {
  /** How long a transport may stay `disconnected` before an ICE restart. */
  disconnectedGraceMs: number;
  /** ICE restarts per transport before falling back to a full reconnect. */
  maxRestarts: number;
}

export interface MediaSoupVTTClientOptions {
  /** WebSocket URL of the SFU (`ws://` or `wss://`). */
  serverUrl?: string;
  /** Shared secret checked by the server's `authenticate` handler. */
  authToken?: string;
  /** Foundry user id of the local user; sent with every request. */
  userId?: string;
  /** Room to join (the Foundry world id). Sent in `authenticate`. */
  roomId?: string;
  /**
   * Identifies this page's connections to the server (defaults to a random
   * id per instance). Sent in `authenticate`, so a reconnect can tell the
   * server which older connection is its own.
   */
  sessionId?: string;
  /** WebSocket implementation (defaults to the global `WebSocket`). */
  WebSocketImpl?: WebSocketConstructor;
  /** Device factory (defaults to `new Device()` from mediasoup-client). */
  deviceFactory?: DeviceFactory;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  reconnect?: Partial<ReconnectPolicy>;
  ice?: Partial<IcePolicy>;
  /** Random source for the backoff jitter (defaults to `Math.random`). */
  random?: () => number;
}

/** Connection parameters that can change between connects. */
export type ConnectionParameters = Pick<
  MediaSoupVTTClientOptions,
  'serverUrl' | 'authToken' | 'userId' | 'roomId'
>;

export interface ProduceOptions {
  /** Start the producer paused (the track is disabled before it is sent). */
  paused?: boolean;
}

/** Why a signaling request failed. */
export type SignalingFailure = 'server' | 'timeout' | 'closed';

/** A rejected signaling request. `failure` says whether the server answered. */
export class SignalingError extends Error {
  readonly requestType: string;
  readonly failure: SignalingFailure;

  constructor(message: string, requestType: string, failure: SignalingFailure) {
    super(message);
    this.name = 'SignalingError';
    this.requestType = requestType;
    this.failure = failure;
  }
}

/** The server rejected `authenticate`. Retrying with the same token cannot help. */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

interface PendingRequest {
  type: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A remote producer, from a `newProducer` notification or a `getProducers` entry. */
export interface RemoteProducerAnnouncement {
  producerId: string;
  userId: string;
  kind: MediaKind;
  paused?: boolean;
}

/** A local track the user wants sent, kept across reconnects. */
interface WantedTrack {
  track: MediaStreamTrack;
  paused: boolean;
}

interface IceRecovery {
  attempts: number;
  restarting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const TAG_KIND: Record<MediaTag, MediaKind> = {
  [APP_DATA_TAG_MIC]: MEDIA_KIND_AUDIO,
  [APP_DATA_TAG_WEBCAM]: MEDIA_KIND_VIDEO,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomSessionId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Validate a signaling URL. Returns the URL string, or throws with a message
 * that can be shown to the user.
 */
export function validateServerUrl(serverUrl: string | undefined): string {
  if (!serverUrl) throw new Error('MediaSoup server URL is not configured.');
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error(`Invalid server URL: ${serverUrl}`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Invalid server URL protocol ${url.protocol} (use ws: or wss:).`);
  }
  return serverUrl;
}

/**
 * Delay before reconnect attempt `attempt` (0-based): exponential from the
 * base delay, capped at the max, with "equal jitter" (a random point in the
 * upper half) so many clients dropped at once do not return in lockstep. The
 * result always lies in `[baseDelayMs, maxDelayMs]`.
 */
export function computeBackoffDelay(
  attempt: number,
  policy: Pick<ReconnectPolicy, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt));
  const jittered = exponential / 2 + random() * (exponential / 2);
  return Math.round(Math.min(policy.maxDelayMs, Math.max(policy.baseDelayMs, jittered)));
}

export class MediaSoupVTTClient extends TypedEmitter<MediaSoupVTTClientEvents> {
  serverUrl: string;
  authToken: string;
  userId: string;
  roomId: string | undefined;
  /** Sent in `authenticate`; stable for the life of this instance. */
  readonly sessionId: string;

  device: MediasoupDevice | null = null;
  socket: WebSocket | null = null;
  sendTransport: Transport | null = null;
  recvTransport: Transport | null = null;
  /** Local producers keyed by media tag (`mic`, `webcam`). */
  readonly producers = new Map<MediaTag, Producer>();
  /** Remote consumers keyed by consumer id. */
  readonly consumers = new Map<string, Consumer>();
  /** producerId -> consumerId. */
  readonly producerToConsumerMap = new Map<string, string>();
  /** consumerId -> userId. */
  readonly consumerToUserMap = new Map<string, string>();
  /** userId -> the current remote track of each kind. */
  readonly remoteUserTracks = new Map<string, Partial<Record<MediaKind, RemoteTrackInfo>>>();
  readonly requestMap = new Map<string, PendingRequest>();
  requestIdCounter = 0;

  #state: ClientState = 'disconnected';
  #connectPromise: Promise<void> | null = null;
  /** Bumped by every teardown so stale async steps can tell they were superseded. */
  #generation = 0;
  /** Producers whose consume request is in flight (dedupe by producerId). */
  readonly #pendingConsumes = new Set<string>();
  /** Producers closed by the server while their consume was in flight. */
  readonly #closedWhilePending = new Set<string>();
  /**
   * Pause state announced (`producerPaused` / `producerResumed`) after the
   * consume response but before the consumer was registered.
   */
  readonly #pausedWhilePending = new Map<string, boolean>();
  /** `newProducer` announcements that arrived before the receive transport. */
  readonly #queuedProducers = new Map<string, RemoteProducerAnnouncement>();
  /** A Device created by {@link prepareDevice} and not yet loaded. */
  #preparedDevice: MediasoupDevice | null = null;

  /** The tracks the user wants sent; survives reconnects, cleared by disconnect. */
  readonly #wanted = new Map<MediaTag, WantedTrack>();
  /** In-flight `sendTransport.produce` per tag, so one tag never gets two producers. */
  readonly #producing = new Map<MediaTag, Promise<Producer | null>>();

  /** Set by {@link disconnect}; a close that follows it never reconnects. */
  #userInitiatedDisconnect = false;
  #reconnecting = false;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #connectedAt = 0;
  /** Bumped by every {@link #beginReconnect}, so a finished attempt can tell a new loop began. */
  #reconnectLoop = 0;
  /** Close code of the last signaling socket that closed under us. */
  #lastCloseCode: number | null = null;
  /** Fails the pending {@link #openSocket} promise; set only while a socket is opening. */
  #abortOpen: ((error: Error) => void) | null = null;

  readonly #ice: Record<TransportDirection, IceRecovery> = {
    send: { attempts: 0, restarting: false, timer: null },
    recv: { attempts: 0, restarting: false, timer: null },
  };

  readonly #WebSocketImpl: WebSocketConstructor | undefined;
  readonly #deviceFactory: DeviceFactory;
  readonly #connectionTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #reconnectPolicy: ReconnectPolicy;
  readonly #icePolicy: IcePolicy;
  readonly #random: () => number;

  constructor(options: MediaSoupVTTClientOptions = {}) {
    super();
    this.serverUrl = options.serverUrl ?? '';
    this.authToken = options.authToken ?? '';
    this.userId = options.userId ?? '';
    this.roomId = options.roomId;
    this.sessionId = options.sessionId ?? randomSessionId();
    this.#WebSocketImpl = options.WebSocketImpl;
    this.#deviceFactory = options.deviceFactory ?? (() => new Device());
    this.#connectionTimeoutMs = options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? SIGNALING_REQUEST_TIMEOUT_MS;
    this.#reconnectPolicy = {
      baseDelayMs: options.reconnect?.baseDelayMs ?? RECONNECT_BASE_DELAY_MS,
      maxDelayMs: options.reconnect?.maxDelayMs ?? RECONNECT_MAX_DELAY_MS,
      maxAttempts: options.reconnect?.maxAttempts ?? RECONNECT_MAX_ATTEMPTS,
    };
    this.#icePolicy = {
      disconnectedGraceMs: options.ice?.disconnectedGraceMs ?? ICE_DISCONNECTED_GRACE_MS,
      maxRestarts: options.ice?.maxRestarts ?? ICE_RESTART_MAX_ATTEMPTS,
    };
    this.#random = options.random ?? Math.random;
  }

  // ==== State ====

  get state(): ClientState {
    return this.#state;
  }

  /** True once signaling is open and both transports exist. */
  get isConnected(): boolean {
    return (
      this.#state === 'connected' &&
      this.socket?.readyState === WS_OPEN &&
      !!this.sendTransport &&
      !!this.recvTransport
    );
  }

  /** True while a first connect or a reconnect is in progress. */
  get isConnecting(): boolean {
    return this.#state === 'connecting' || this.#state === 'reconnecting';
  }

  /** True while the backoff reconnect loop is running. */
  get isReconnecting(): boolean {
    return this.#reconnecting;
  }

  /** Update the connection parameters used by the next {@link connect}. */
  configure(params: ConnectionParameters): void {
    if (params.serverUrl !== undefined) this.serverUrl = params.serverUrl;
    if (params.authToken !== undefined) this.authToken = params.authToken;
    if (params.userId !== undefined) this.userId = params.userId;
    if ('roomId' in params) this.roomId = params.roomId;
  }

  #setState(state: ClientState, reason?: string): void {
    const previous = this.#state;
    if (previous === state) return;
    this.#state = state;
    log(`Transport state: ${previous} -> ${state}${reason ? ` (${reason})` : ''}`, 'debug');
    this.emit('stateChanged', reason ? { state, previous, reason } : { state, previous });
  }

  // ==== Device ====

  /**
   * Create the mediasoup-client Device ahead of connecting. This detects the
   * browser's WebRTC handler, so an unsupported browser fails here with
   * mediasoup-client's UnsupportedError. Returns the handler name.
   */
  prepareDevice(): string {
    if (!this.#preparedDevice) this.#preparedDevice = this.#deviceFactory();
    return this.#preparedDevice.handlerName;
  }

  /** A Device can be loaded only once, so each connection gets a fresh one. */
  #takeDevice(): MediasoupDevice {
    const prepared = this.#preparedDevice;
    this.#preparedDevice = null;
    if (prepared && !prepared.loaded) return prepared;
    return this.#deviceFactory();
  }

  #requireDevice(): MediasoupDevice {
    if (!this.device || !this.socket) throw new Error('Not connected: no device or socket.');
    return this.device;
  }

  // ==== Connection ====

  /**
   * Open signaling, authenticate, load the Device, create both transports and
   * consume the room's existing producers. Resolves when connected; rejects
   * (with state `failed`) otherwise. A second call while connecting returns
   * the same promise. Called during a reconnect loop, it stops the loop and
   * tries at once.
   */
  connect(): Promise<void> {
    this.#userInitiatedDisconnect = false;
    if (this.isConnected) return Promise.resolve();
    if (this.#connectPromise) return this.#connectPromise;
    if (this.#reconnecting) this.#stopReconnectLoop();
    return this.#startConnect();
  }

  #startConnect(): Promise<void> {
    const promise = this.#doConnect().finally(() => {
      if (this.#connectPromise === promise) this.#connectPromise = null;
    });
    this.#connectPromise = promise;
    return promise;
  }

  async #doConnect(): Promise<void> {
    const url = validateServerUrl(this.serverUrl);
    // Clear any half-open state from a previous attempt. The wanted tracks
    // stay, so a reconnect can re-produce them.
    this.#teardown();
    this.#lastCloseCode = null;
    const generation = this.#generation;
    this.#setState(this.#reconnecting ? 'reconnecting' : 'connecting');
    log(`Connecting to MediaSoup server at ${url}...`);

    const assertCurrent = () => {
      if (generation !== this.#generation) throw new Error('Connection attempt was superseded.');
    };

    try {
      await this.#openSocket(url);
      assertCurrent();

      // The server requires authenticate as the opening frame and gates all
      // other signaling behind it (see #118). roomId selects the router.
      // `reconnect` + `sessionId` tell the server this is the backoff loop of
      // an existing session: it may replace only this session's own stale
      // connection, never a newer session of the same user (another tab).
      const auth: Record<string, unknown> = {
        token: this.authToken,
        sessionId: this.sessionId,
        reconnect: this.#reconnecting,
      };
      if (this.roomId) auth.roomId = this.roomId;
      try {
        await this.request(SIG_MSG_TYPES.AUTHENTICATE, auth);
      } catch (error) {
        if (error instanceof SignalingError && error.failure === 'server') {
          throw new AuthenticationError(`Authentication failed: ${error.message}`);
        }
        throw error;
      }
      assertCurrent();

      const routerRtpCapabilities: RtpCapabilities = await this.request(
        SIG_MSG_TYPES.GET_ROUTER_RTP_CAPABILITIES,
      );
      if (!routerRtpCapabilities || Object.keys(routerRtpCapabilities).length === 0) {
        throw new Error('Server returned empty router RTP capabilities.');
      }
      assertCurrent();

      const device = this.#takeDevice();
      await device.load({ routerRtpCapabilities });
      assertCurrent();
      this.device = device;

      this.sendTransport = await this.#createTransport('send');
      assertCurrent();
      this.recvTransport = await this.#createTransport('recv');
      assertCurrent();

      if (this.socket?.readyState !== WS_OPEN) {
        throw new Error('Signaling closed while connecting.');
      }
    } catch (error) {
      if (generation === this.#generation) {
        this.#teardown();
        if (this.#reconnecting) {
          this.#setState('reconnecting', errorMessage(error));
        } else {
          this.#wanted.clear();
          this.#setState('failed', errorMessage(error));
        }
      }
      throw error;
    }

    const wasReconnecting = this.#reconnecting;
    this.#reconnecting = false;
    this.#connectedAt = Date.now();
    this.#setState('connected', wasReconnecting ? 'reconnected' : undefined);
    log(
      wasReconnecting ? 'Reconnected to MediaSoup server.' : 'Connected to MediaSoup server.',
      'info',
    );

    this.#restoreProducers();
    this.#flushQueuedProducers();
    await this.#consumeExistingProducers(generation);
  }

  /** Close everything and stop any reconnect. Safe to call in any state. */
  disconnect(): void {
    const wasActive = this.#state !== 'disconnected' && this.#state !== 'failed';
    if (wasActive) log('Disconnecting from MediaSoup server...', 'info');
    this.#userInitiatedDisconnect = true;
    this.#stopReconnectLoop();
    this.#reconnectAttempt = 0;
    this.#wanted.clear();
    // The in-flight attempt (if any) is superseded; teardown fails it, and the
    // next connect() must start a fresh one instead of returning it.
    this.#connectPromise = null;
    this.#teardown();
    this.#setState('disconnected');
  }

  #openSocket(url: string): Promise<void> {
    const WebSocketImpl = this.#WebSocketImpl ?? globalThis.WebSocket;
    if (!WebSocketImpl) return Promise.reject(new Error('WebSocket is not available.'));

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocketImpl(url);
      this.socket = socket;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#abortOpen === fail) this.#abortOpen = null;
        reject(error);
      };
      this.#abortOpen = fail;

      const timer = setTimeout(() => {
        if (settled) return;
        fail(new Error(`Connection timed out after ${this.#connectionTimeoutMs} ms.`));
        if (this.socket === socket) {
          this.#detachSocket(socket);
          this.socket = null;
        }
        try {
          socket.close();
        } catch {
          // Already closing.
        }
      }, this.#connectionTimeoutMs);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#abortOpen === fail) this.#abortOpen = null;
        log('WebSocket connection established.', 'debug');
        resolve();
      };
      socket.onmessage = (event: MessageEvent) => this.#onSocketMessage(event);
      // An error on an open socket is always followed by a close event; only
      // the close handler recovers, so an error and a close start one loop.
      socket.onerror = () => {
        log('WebSocket error.', 'warn');
        fail(new Error('WebSocket connection error.'));
      };
      socket.onclose = (event: CloseEvent) => {
        if (!settled) {
          fail(new Error(`WebSocket closed before opening (code ${event.code}).`));
          return;
        }
        this.#onSocketClosed(socket, event);
      };
    });
  }

  #detachSocket(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }

  #onSocketClosed(socket: WebSocket, event: CloseEvent): void {
    if (socket !== this.socket) return;
    const reason = `WebSocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`;
    this.#lastCloseCode = event.code;
    log(reason, event.wasClean ? 'info' : 'warn');

    if (this.#state !== 'connected') {
      // A connect attempt owns this socket. Fail its pending request so the
      // attempt cleans up and decides whether to retry.
      this.#detachSocket(socket);
      this.socket = null;
      this.#rejectPending(new SignalingError(reason, 'connect', 'closed'));
      return;
    }

    if (this.#userInitiatedDisconnect) {
      this.#teardown();
      this.#setState('disconnected', reason);
      return;
    }

    if (event.code === CLOSE_CODE_REPLACED) {
      // A newer connection for this user joined; reconnecting would evict it.
      this.#wanted.clear();
      this.#teardown();
      this.#setState('failed', 'Replaced by a newer connection for this user');
      return;
    }

    this.#beginReconnect(reason);
  }

  /**
   * Release every resource. Emits `consumerRemoved` for each remote track so
   * listeners can drop them. Does not change the state, and keeps the wanted
   * local tracks.
   */
  #teardown(): void {
    this.#generation++;

    // A socket still opening belongs to the superseded attempt: fail it now
    // rather than when its connection timeout fires.
    const abortOpen = this.#abortOpen;
    this.#abortOpen = null;
    abortOpen?.(new SignalingError('Disconnected.', 'connect', 'closed'));

    for (const producer of this.producers.values()) {
      if (!producer.closed) producer.close();
    }
    this.producers.clear();
    this.#producing.clear();

    for (const consumerId of [...this.consumers.keys()]) {
      this.#removeConsumer(consumerId, false);
    }
    this.consumers.clear();
    this.producerToConsumerMap.clear();
    this.consumerToUserMap.clear();
    this.remoteUserTracks.clear();
    this.#pendingConsumes.clear();
    this.#closedWhilePending.clear();
    this.#pausedWhilePending.clear();
    this.#queuedProducers.clear();

    for (const ice of Object.values(this.#ice)) {
      if (ice.timer) clearTimeout(ice.timer);
      ice.timer = null;
      ice.attempts = 0;
      ice.restarting = false;
    }

    if (this.sendTransport && !this.sendTransport.closed) this.sendTransport.close();
    if (this.recvTransport && !this.recvTransport.closed) this.recvTransport.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.device = null;

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      this.#detachSocket(socket);
      if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
        try {
          socket.close();
        } catch {
          // Already closing.
        }
      }
    }

    this.#rejectPending(new SignalingError('Disconnected.', 'teardown', 'closed'));
    this.requestIdCounter = 0;
  }

  #rejectPending(error: Error): void {
    const pending = [...this.requestMap.values()];
    this.requestMap.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  // ==== Reconnect ====

  /**
   * Start the backoff reconnect loop after an unexpected loss. Does nothing if
   * the loop is already running or the user disconnected, so a socket error,
   * a socket close and an ICE failure together still start only one loop.
   */
  #beginReconnect(reason: string): void {
    if (this.#userInitiatedDisconnect || this.#reconnecting) return;
    // A connection that stayed up for a while starts a fresh budget; one that
    // drops right after connecting keeps counting, so a flapping server still
    // hits the attempt limit.
    if (Date.now() - this.#connectedAt >= this.#reconnectPolicy.maxDelayMs) {
      this.#reconnectAttempt = 0;
    }
    log(`Lost the MediaSoup connection (${reason}); reconnecting.`, 'warn');
    this.#reconnecting = true;
    this.#reconnectLoop++;
    this.#teardown();
    this.#setState('reconnecting', reason);
    this.#scheduleReconnect(reason);
  }

  #scheduleReconnect(reason: string): void {
    const { maxAttempts } = this.#reconnectPolicy;
    if (this.#reconnectAttempt >= maxAttempts) {
      this.#giveUpReconnect(`gave up after ${this.#reconnectAttempt} attempts: ${reason}`);
      return;
    }
    const delayMs = computeBackoffDelay(
      this.#reconnectAttempt,
      this.#reconnectPolicy,
      this.#random,
    );
    this.#reconnectAttempt++;
    const attempt = this.#reconnectAttempt;
    log(`Reconnect attempt ${attempt}/${maxAttempts} in ${delayMs} ms.`, 'info');
    this.emit('reconnecting', { attempt, maxAttempts, delayMs, reason });
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#runReconnectAttempt();
    }, delayMs);
  }

  async #runReconnectAttempt(): Promise<void> {
    if (!this.#reconnecting) return;
    const loop = this.#reconnectLoop;
    // Another loop began while the attempt ran (the connection came up and
    // dropped again): that loop already scheduled its own next attempt.
    const superseded = () => loop !== this.#reconnectLoop || this.#reconnectTimer !== null;
    try {
      await (this.#connectPromise ?? this.#startConnect());
      // A successful attempt ends the loop. Still looping means the promise
      // belonged to a connection that dropped again; keep going.
      if (superseded()) return;
      if (this.#reconnecting && !this.isConnected) this.#scheduleReconnect('connection lost again');
    } catch (error) {
      if (!this.#reconnecting || superseded()) return;
      const reason = errorMessage(error);
      if (error instanceof AuthenticationError || this.#lastCloseCode === CLOSE_CODE_REPLACED) {
        this.#giveUpReconnect(reason);
        return;
      }
      this.#scheduleReconnect(reason);
    }
  }

  #stopReconnectLoop(): void {
    this.#reconnecting = false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #giveUpReconnect(reason: string): void {
    log(`Reconnect failed: ${reason}`, 'error', true);
    this.#stopReconnectLoop();
    this.#reconnectAttempt = 0;
    this.#wanted.clear();
    this.#teardown();
    this.#setState('failed', `Reconnect failed: ${reason}`);
  }

  // ==== Signaling ====

  /**
   * Send a request and resolve with the response's `data` field. Rejects with
   * a {@link SignalingError} on an error reply, a closed socket or a timeout.
   */
  request(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WS_OPEN) {
        reject(new SignalingError('WebSocket is not open.', type, 'closed'));
        return;
      }
      const requestId = `req_${this.requestIdCounter++}`;
      const timer = setTimeout(() => {
        if (!this.requestMap.delete(requestId)) return;
        log(`Signaling request ${requestId} (${type}) timed out.`, 'warn');
        reject(new SignalingError(`Request '${type}' timed out`, type, 'timeout'));
      }, timeoutMs ?? this.#requestTimeoutMs);
      this.requestMap.set(requestId, { type, resolve, reject, timer });
      log(`Sending signaling request ${requestId}: ${type}`, 'debug');
      try {
        socket.send(JSON.stringify({ ...payload, type, requestId, userId: this.userId }));
      } catch (error) {
        this.requestMap.delete(requestId);
        clearTimeout(timer);
        reject(new SignalingError(errorMessage(error), type, 'closed'));
      }
    });
  }

  #onSocketMessage(event: MessageEvent): void {
    let message: any;
    try {
      message = JSON.parse(String(event.data));
    } catch (error) {
      log(`Could not parse signaling message: ${errorMessage(error)}`, 'error');
      return;
    }
    this.handleSignalingMessage(message);
  }

  /** Route a parsed message to its pending request or notification handler. */
  handleSignalingMessage(message: any): void {
    if (!message || typeof message !== 'object') return;
    const pending = message.requestId ? this.requestMap.get(message.requestId) : undefined;
    if (pending) {
      this.requestMap.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.error) {
        log(
          `Signaling request ${message.requestId} (${pending.type}) failed: ${message.error}`,
          'warn',
        );
        pending.reject(new SignalingError(String(message.error), pending.type, 'server'));
      } else {
        pending.resolve(message.data ?? message);
      }
      return;
    }

    switch (message.type) {
      case SIG_MSG_TYPES.NEW_PRODUCER:
        void this.handleNewRemoteProducer(message);
        break;
      case SIG_MSG_TYPES.PRODUCER_CLOSED:
        this.handleRemoteProducerClosed(message.producerId);
        break;
      case SIG_MSG_TYPES.PRODUCER_PAUSED:
        this.handleRemoteProducerPaused(message.producerId, true);
        break;
      case SIG_MSG_TYPES.PRODUCER_RESUMED:
        this.handleRemoteProducerPaused(message.producerId, false);
        break;
      default:
        // Includes `{requestId?, error}` replies to frames the server could
        // not parse, when no request is waiting for them.
        if (message.error) log(`Server error: ${message.error}`, 'warn');
        else log(`Unhandled signaling message type: ${message.type}`, 'debug');
    }
  }

  async #createTransport(direction: TransportDirection): Promise<Transport> {
    this.#requireDevice();
    const info: TransportOptions = await this.request(SIG_MSG_TYPES.CREATE_WEBRTC_TRANSPORT, {
      forceTcp: false,
      producing: direction === 'send',
      consuming: direction === 'recv',
    });
    const device = this.#requireDevice();
    const transport =
      direction === 'send' ? device.createSendTransport(info) : device.createRecvTransport(info);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.request(SIG_MSG_TYPES.CONNECT_TRANSPORT, { transportId: transport.id, dtlsParameters })
        .then(() => callback())
        .catch((error: Error) => errback(error));
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        this.request(SIG_MSG_TYPES.PRODUCE, {
          transportId: transport.id,
          kind,
          rtpParameters,
          // The server creates the producer in this state, so a track that
          // starts paused is never announced (or consumed) as live.
          paused: appData?.paused === true,
          appData,
        })
          .then(({ id }: { id: string }) => callback({ id }))
          .catch((error: Error) => errback(error));
      });
    }

    transport.on('connectionstatechange', (state) => {
      log(`${direction} transport connection state: ${state}`, 'debug');
      if (this.#transportFor(direction) !== transport) return;
      this.emit('transportStateChanged', { direction, state });
      this.#onTransportConnectionState(direction, transport, state);
    });

    return transport;
  }

  #transportFor(direction: TransportDirection): Transport | null {
    return direction === 'send' ? this.sendTransport : this.recvTransport;
  }

  // ==== ICE recovery ====

  #onTransportConnectionState(
    direction: TransportDirection,
    transport: Transport,
    state: TransportConnectionState,
  ): void {
    const ice = this.#ice[direction];
    switch (state) {
      case 'connected':
        if (ice.timer) clearTimeout(ice.timer);
        ice.timer = null;
        ice.attempts = 0;
        break;
      case 'disconnected':
        // ICE often recovers from a short network blip by itself.
        if (!ice.timer && !ice.restarting) this.#scheduleIceCheck(direction, transport);
        break;
      case 'failed':
        if (ice.timer) clearTimeout(ice.timer);
        ice.timer = null;
        void this.#restartIce(direction, transport);
        break;
      case 'closed':
        if (ice.timer) clearTimeout(ice.timer);
        ice.timer = null;
        break;
      default:
        break;
    }
  }

  /** After the grace period, restart ICE if the transport is still down. */
  #scheduleIceCheck(direction: TransportDirection, transport: Transport): void {
    const ice = this.#ice[direction];
    if (ice.timer) clearTimeout(ice.timer);
    ice.timer = setTimeout(() => {
      ice.timer = null;
      if (this.#transportFor(direction) !== transport || transport.closed) return;
      const state = transport.connectionState;
      if (state === 'disconnected' || state === 'failed') {
        void this.#restartIce(direction, transport);
      }
    }, this.#icePolicy.disconnectedGraceMs);
  }

  /**
   * Ask the server for new ICE parameters and restart ICE on the transport.
   * One restart runs at a time per transport; after `maxRestarts` restarts
   * without reaching `connected`, fall back to a full reconnect.
   */
  async #restartIce(direction: TransportDirection, transport: Transport): Promise<void> {
    const ice = this.#ice[direction];
    if (ice.restarting || this.#transportFor(direction) !== transport || transport.closed) return;
    // Without signaling the socket-close handler is already reconnecting.
    if (!this.isConnected) return;
    if (ice.attempts >= this.#icePolicy.maxRestarts) {
      this.#beginReconnect(`${direction} transport ICE failed after ${ice.attempts} restarts`);
      return;
    }

    ice.attempts++;
    ice.restarting = true;
    const generation = this.#generation;
    log(`Restarting ICE on the ${direction} transport (attempt ${ice.attempts}).`, 'warn');
    this.emit('iceRestart', { direction, attempt: ice.attempts });
    try {
      const { iceParameters } = (await this.request(SIG_MSG_TYPES.RESTART_ICE, {
        transportId: transport.id,
      })) as { iceParameters: IceParameters };
      if (generation !== this.#generation || transport.closed) return;
      if (!iceParameters) throw new Error('Server returned no ICE parameters.');
      await transport.restartIce({ iceParameters });
    } catch (error) {
      if (generation !== this.#generation) return;
      log(`ICE restart on the ${direction} transport failed: ${errorMessage(error)}`, 'warn');
    } finally {
      if (generation === this.#generation) ice.restarting = false;
    }
    // Check again after the grace period; a transport that is still down
    // restarts again or falls back to a full reconnect.
    if (generation === this.#generation && !transport.closed) {
      this.#scheduleIceCheck(direction, transport);
    }
  }

  // ==== Local media (producers) ====

  getProducer(tag: MediaTag): Producer | undefined {
    return this.producers.get(tag);
  }

  canProduce(kind: MediaKind): boolean {
    return this.isConnected && !!this.device?.canProduce(kind);
  }

  /**
   * Send a local track under a media tag. If a producer for the tag already
   * exists its track is replaced instead. The core never stops the tracks it
   * is given; the caller owns them.
   *
   * The track is remembered as wanted: while a connect or reconnect is in
   * progress this resolves with `null` and the track is produced once the
   * connection is up, and a reconnect re-produces it.
   */
  async produce(
    tag: MediaTag,
    track: MediaStreamTrack,
    options: ProduceOptions = {},
  ): Promise<Producer | null> {
    const paused = options.paused ?? false;
    const kind = TAG_KIND[tag];
    if (track.kind !== kind) throw new Error(`Track kind ${track.kind} does not match ${tag}.`);
    this.#wanted.set(tag, { track, paused });

    // Serialize per tag so two calls never create two producers.
    for (let inflight = this.#producing.get(tag); inflight; inflight = this.#producing.get(tag)) {
      await inflight.catch(() => null);
    }

    const existing = this.producers.get(tag);
    if (existing && !existing.closed) {
      await existing.replaceTrack({ track });
      if (paused) this.pauseProducer(tag);
      else this.resumeProducer(tag);
      return existing;
    }

    if (!this.isConnected || !this.sendTransport) {
      // `connected` with a socket that is not open means the close event is
      // still on its way; the reconnect it starts re-sends the wanted track.
      if (this.isConnecting || this.#state === 'connected') {
        log(`Not connected yet; ${tag} will be sent once connected.`, 'debug');
        return null;
      }
      this.#wanted.delete(tag);
      throw new Error('Not connected.');
    }
    if (!this.device?.canProduce(kind)) {
      this.#wanted.delete(tag);
      throw new Error(`This device cannot produce ${kind}.`);
    }

    const promise = this.#createProducer(tag, track, paused, this.sendTransport);
    this.#producing.set(tag, promise);
    try {
      return await promise;
    } finally {
      if (this.#producing.get(tag) === promise) this.#producing.delete(tag);
    }
  }

  async #createProducer(
    tag: MediaTag,
    track: MediaStreamTrack,
    paused: boolean,
    sendTransport: Transport,
  ): Promise<Producer | null> {
    const kind = TAG_KIND[tag];
    const generation = this.#generation;
    // mediasoup-client creates the producer paused exactly when the track is
    // disabled, so set it explicitly. `appData.paused` reaches the server in
    // the produce request, which creates its producer paused too.
    track.enabled = !paused;
    const producer = await sendTransport.produce({
      track,
      stopTracks: false,
      appData: { mediaTag: tag, userId: this.userId, paused },
    });
    if (generation !== this.#generation) {
      producer.close();
      // Superseded by a reconnect (which re-produces the wanted track) or a
      // disconnect (which dropped it).
      return null;
    }
    if (!this.#wanted.has(tag)) {
      // Stopped while the produce request was in flight.
      producer.close();
      this.#notify(SIG_MSG_TYPES.CLOSE_PRODUCER, { producerId: producer.id });
      return null;
    }

    this.producers.set(tag, producer);
    log(`Producer ${producer.id} created for ${tag}.`, 'info');

    producer.on('trackended', () => {
      log(`Local ${kind} track ended (device removed?).`, 'warn');
      this.emit('localTrackEnded', { tag, kind });
    });
    producer.on('transportclose', () => {
      if (this.producers.get(tag) === producer) this.producers.delete(tag);
    });

    // Apply the latest wanted pause state; it may have changed while the
    // produce request was in flight. The server's producer was created with
    // `paused`, so it only needs a request when the wanted state differs.
    const wantPaused = this.#wanted.get(tag)?.paused ?? paused;
    if (producer.paused !== wantPaused) {
      if (wantPaused) producer.pause();
      else producer.resume();
    }
    if (wantPaused !== paused) {
      this.#notify(wantPaused ? SIG_MSG_TYPES.PAUSE_PRODUCER : SIG_MSG_TYPES.RESUME_PRODUCER, {
        producerId: producer.id,
      });
    }
    return producer;
  }

  startLocalAudio(track: MediaStreamTrack, options?: ProduceOptions): Promise<Producer | null> {
    return this.produce(APP_DATA_TAG_MIC, track, options);
  }

  startLocalVideo(track: MediaStreamTrack, options?: ProduceOptions): Promise<Producer | null> {
    return this.produce(APP_DATA_TAG_WEBCAM, track, options);
  }

  /** Swap the track a producer sends (null sends nothing, keeping the producer). */
  async replaceTrack(tag: MediaTag, track: MediaStreamTrack | null): Promise<boolean> {
    const wanted = this.#wanted.get(tag);
    if (track && wanted) wanted.track = track;
    const producer = this.producers.get(tag);
    if (!producer || producer.closed) return false;
    await producer.replaceTrack({ track });
    return true;
  }

  /**
   * Pause a producer locally and tell the server. Returns whether the state
   * changed. The server notification runs in the background. Without a
   * producer (for example while reconnecting) only the wanted state changes.
   */
  pauseProducer(tag: MediaTag): boolean {
    const wanted = this.#wanted.get(tag);
    if (wanted) wanted.paused = true;
    const producer = this.producers.get(tag);
    if (!producer || producer.closed || producer.paused) return false;
    producer.pause();
    this.#notify(SIG_MSG_TYPES.PAUSE_PRODUCER, { producerId: producer.id });
    return true;
  }

  resumeProducer(tag: MediaTag): boolean {
    const wanted = this.#wanted.get(tag);
    if (wanted) wanted.paused = false;
    const producer = this.producers.get(tag);
    if (!producer || producer.closed || !producer.paused) return false;
    producer.resume();
    this.#notify(SIG_MSG_TYPES.RESUME_PRODUCER, { producerId: producer.id });
    return true;
  }

  /**
   * Stop sending a tag. Closes the local producer and, when `notifyServer` is
   * true and signaling is open, sends `closeProducer` so the server closes it
   * and tells the other peers (`producerClosed`). Returns whether a producer
   * was closed.
   */
  closeProducer(tag: MediaTag, notifyServer = true): boolean {
    this.#wanted.delete(tag);
    const producer = this.producers.get(tag);
    if (!producer) return false;
    const producerId = producer.id;
    log(`Closing ${tag} producer ${producerId}.`, 'info');
    if (!producer.closed) producer.close();
    this.producers.delete(tag);
    if (notifyServer) this.#notify(SIG_MSG_TYPES.CLOSE_PRODUCER, { producerId });
    return true;
  }

  stopLocalAudio(notifyServer = true): boolean {
    return this.closeProducer(APP_DATA_TAG_MIC, notifyServer);
  }

  stopLocalVideo(notifyServer = true): boolean {
    return this.closeProducer(APP_DATA_TAG_WEBCAM, notifyServer);
  }

  /** Re-produce the wanted tracks after a (re)connect. */
  #restoreProducers(): void {
    for (const [tag, wanted] of [...this.#wanted]) {
      if (wanted.track.readyState === 'ended') {
        this.#wanted.delete(tag);
        this.emit('localTrackEnded', { tag, kind: TAG_KIND[tag] });
        continue;
      }
      this.produce(tag, wanted.track, { paused: wanted.paused }).catch((error: unknown) =>
        log(`Could not re-send ${tag}: ${errorMessage(error)}`, 'error'),
      );
    }
  }

  /** Fire-and-forget request; failures are only logged. */
  #notify(type: string, payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WS_OPEN) return;
    this.request(type, payload).catch((error: unknown) =>
      log(`Request ${type} failed: ${errorMessage(error)}`, 'warn'),
    );
  }

  // ==== Remote media (consumers) ====

  /** User ids that currently have at least one consumed track. */
  getRemoteUserIds(): string[] {
    return [...this.remoteUserTracks.keys()];
  }

  getRemoteTracks(userId: string): { audio?: MediaStreamTrack; video?: MediaStreamTrack } {
    const entry = this.remoteUserTracks.get(userId);
    const tracks: { audio?: MediaStreamTrack; video?: MediaStreamTrack } = {};
    if (entry?.audio) tracks.audio = entry.audio.track;
    if (entry?.video) tracks.video = entry.video.track;
    return tracks;
  }

  /** The consumed tracks of a user, with their metadata. */
  getRemoteTrackInfo(userId: string): Partial<Record<MediaKind, RemoteTrackInfo>> {
    return { ...this.remoteUserTracks.get(userId) };
  }

  /** Fetch the room's existing producers after joining and consume each. */
  async #consumeExistingProducers(generation: number): Promise<void> {
    let producers: RemoteProducerAnnouncement[];
    try {
      const response = await this.request(SIG_MSG_TYPES.GET_PRODUCERS);
      producers = Array.isArray(response?.producers) ? response.producers : [];
    } catch (error) {
      if (generation === this.#generation) {
        log(`Could not list the room's producers: ${errorMessage(error)}`, 'warn');
      }
      return;
    }
    if (generation !== this.#generation) return;
    log(`Room has ${producers.length} existing producer(s).`, 'debug');
    for (const producer of producers) void this.handleNewRemoteProducer(producer);
  }

  #flushQueuedProducers(): void {
    const queued = [...this.#queuedProducers.values()];
    this.#queuedProducers.clear();
    for (const announcement of queued) void this.handleNewRemoteProducer(announcement);
  }

  /**
   * Consume a producer announced by the server (`newProducer` or a
   * `getProducers` entry). Idempotent by producerId, ignores the local user's
   * own producers, and queues announcements that arrive before the receive
   * transport exists.
   */
  async handleNewRemoteProducer(announcement: RemoteProducerAnnouncement): Promise<void> {
    if (!announcement) return;
    const { producerId, userId, kind } = announcement;
    if (!producerId || !userId) return;
    if (userId === this.userId) return;
    if (this.producerToConsumerMap.has(producerId) || this.#pendingConsumes.has(producerId)) {
      log(`Producer ${producerId} is already consumed; ignoring.`, 'debug');
      return;
    }
    const recvTransport = this.recvTransport;
    const device = this.device;
    if (!this.isConnected || !recvTransport || !device) {
      if (this.isConnecting) {
        log(`Queueing producer ${producerId} until the receive transport is ready.`, 'debug');
        this.#queuedProducers.set(producerId, announcement);
      } else {
        log(`Cannot consume producer ${producerId}: not connected.`, 'warn');
      }
      return;
    }

    log(`Consuming ${kind} producer ${producerId} from user ${userId}.`, 'info');
    const generation = this.#generation;
    this.#pendingConsumes.add(producerId);
    try {
      // The server checks router.canConsume against these capabilities.
      const params = await this.request(SIG_MSG_TYPES.CONSUME, {
        transportId: recvTransport.id,
        producerId,
        rtpCapabilities: device.recvRtpCapabilities,
      });
      if (!params?.id) throw new Error('Server returned no consumer parameters.');
      if (generation !== this.#generation) return;
      // The response is newer than any pause notification before it.
      this.#pausedWhilePending.delete(producerId);
      if (this.#closedWhilePending.has(producerId)) {
        // The server already closed its consumer along with the producer.
        log(`Producer ${producerId} closed while it was being consumed.`, 'debug');
        return;
      }

      let producerPaused = params.producerPaused === true;
      const consumer = await recvTransport.consume({
        id: params.id,
        producerId: params.producerId ?? producerId,
        kind: params.kind ?? kind,
        rtpParameters: params.rtpParameters,
        appData: { userId, producerId, producerPaused },
      });
      if (generation !== this.#generation) {
        consumer.close();
        return;
      }
      if (this.#closedWhilePending.has(producerId)) {
        consumer.close();
        return;
      }
      const latePause = this.#pausedWhilePending.get(producerId);
      if (latePause !== undefined) {
        producerPaused = latePause;
        consumer.appData.producerPaused = latePause;
      }

      this.consumers.set(consumer.id, consumer);
      this.producerToConsumerMap.set(producerId, consumer.id);
      this.consumerToUserMap.set(consumer.id, userId);

      const info: RemoteTrackInfo = {
        userId,
        kind: consumer.kind,
        track: consumer.track,
        consumerId: consumer.id,
        producerId,
        producerPaused,
      };
      const entry = this.remoteUserTracks.get(userId) ?? {};
      entry[consumer.kind] = info;
      this.remoteUserTracks.set(userId, entry);

      consumer.on('trackended', () => this.#removeConsumer(consumer.id, true));
      consumer.on('transportclose', () => this.#removeConsumer(consumer.id, false));

      // The server creates consumers paused (mediasoup's recommendation).
      try {
        await this.request(SIG_MSG_TYPES.CONSUMER_RESUME, { consumerId: consumer.id });
      } catch (error) {
        log(`Could not resume consumer ${consumer.id}: ${errorMessage(error)}`, 'warn');
      }
      if (generation !== this.#generation || !this.consumers.has(consumer.id)) return;

      if (producerPaused) log(`Remote ${consumer.kind} of user ${userId} is paused.`, 'debug');
      this.emit('consumerAdded', info);
    } catch (error) {
      if (generation === this.#generation) {
        log(`Could not consume producer ${producerId}: ${errorMessage(error)}`, 'error');
      }
    } finally {
      if (generation === this.#generation) {
        this.#pendingConsumes.delete(producerId);
        this.#closedWhilePending.delete(producerId);
        this.#pausedWhilePending.delete(producerId);
      }
    }
  }

  /**
   * The server paused or resumed a remote producer we consume
   * (`producerPaused` / `producerResumed`). Updates the track's
   * `producerPaused` and emits `consumerUpdated` when it changed.
   */
  handleRemoteProducerPaused(producerId: string, paused: boolean): void {
    if (!producerId) return;
    const queued = this.#queuedProducers.get(producerId);
    if (queued) queued.paused = paused;
    const consumerId = this.producerToConsumerMap.get(producerId);
    const consumer = consumerId ? this.consumers.get(consumerId) : undefined;
    if (!consumer) {
      if (this.#pendingConsumes.has(producerId)) this.#pausedWhilePending.set(producerId, paused);
      return;
    }
    consumer.appData.producerPaused = paused;
    const userId = this.consumerToUserMap.get(consumer.id);
    const info = userId ? this.remoteUserTracks.get(userId)?.[consumer.kind] : undefined;
    if (!info || info.consumerId !== consumer.id || info.producerPaused === paused) return;
    info.producerPaused = paused;
    log(
      `Remote ${consumer.kind} of user ${info.userId} ${paused ? 'paused' : 'resumed'}.`,
      'debug',
    );
    this.emit('consumerUpdated', info);
  }

  handleRemoteProducerClosed(producerId: string): void {
    if (!producerId) return;
    this.#queuedProducers.delete(producerId);
    const consumerId = this.producerToConsumerMap.get(producerId);
    if (!consumerId) {
      if (this.#pendingConsumes.has(producerId)) this.#closedWhilePending.add(producerId);
      else log(`No consumer for closed producer ${producerId}.`, 'debug');
      return;
    }
    // The server closes its side of the consumer with the producer.
    this.#removeConsumer(consumerId, false);
  }

  /** Stop receiving a consumer and tell the server (`closeConsumer`). */
  closeConsumer(consumerId: string): boolean {
    if (!this.consumers.has(consumerId)) return false;
    this.#removeConsumer(consumerId, true);
    return true;
  }

  #removeConsumer(consumerId: string, notifyServer: boolean): void {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) return;
    this.consumers.delete(consumerId);
    if (!consumer.closed) consumer.close();
    if (notifyServer) this.#notify(SIG_MSG_TYPES.CLOSE_CONSUMER, { consumerId });

    const userId = this.consumerToUserMap.get(consumerId) ?? String(consumer.appData.userId ?? '');
    this.consumerToUserMap.delete(consumerId);
    if (this.producerToConsumerMap.get(consumer.producerId) === consumerId) {
      this.producerToConsumerMap.delete(consumer.producerId);
    }

    const entry = this.remoteUserTracks.get(userId);
    const info = entry?.[consumer.kind];
    // Only clear the slot when it still holds this consumer's track.
    if (entry && info?.consumerId === consumerId) {
      delete entry[consumer.kind];
      if (!entry.audio && !entry.video) this.remoteUserTracks.delete(userId);
    }

    log(`Consumer ${consumerId} (${consumer.kind}) for user ${userId} removed.`, 'debug');
    this.emit('consumerRemoved', {
      userId,
      kind: consumer.kind,
      track: consumer.track,
      consumerId,
      producerId: consumer.producerId,
      producerPaused: consumer.appData.producerPaused === true,
    });
  }
}
