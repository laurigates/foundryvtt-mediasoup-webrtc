/**
 * An in-memory fake of the MediaSoupVTT SFU and the WebSocket to reach it.
 *
 * `FakeSfu` answers the signaling contract of `server/src/server.rs` and
 * `server/src/room.rs` (responses `{requestId, data}`, errors
 * `{requestId, error}`, flat notifications `{type, ...fields}`):
 * - `authenticate` must be the first frame; checks the token; joins the peer
 *   to `roomId` and evicts an older peer of the same user with close code
 *   4001 (a `reconnect` join from another session is refused instead);
 * - `getRouterRtpCapabilities`, `createWebRtcTransport`, `restartIce` and
 *   `consume` answer with mediasoup-client's `testFakeParameters`;
 * - `produce` records the producer (born paused when asked) and broadcasts
 *   `newProducer` to the rest of the room; `getProducers` lists everybody
 *   else's producers; `closeProducer` (owner only) broadcasts
 *   `producerClosed`; pause/resume notifies the consumers
 *   (`producerPaused` / `producerResumed`);
 * - `consume` requires `rtpCapabilities` with codecs (the server's
 *   `router.canConsume` check) and reports `producerPaused`;
 * - a peer whose socket closes is removed, and its producers are announced
 *   as closed.
 *
 * Several clients can share one `FakeSfu`, so a test can run two peers
 * through the same room: A's producers reach B.
 */

import { testFakeParameters } from 'mediasoup-client';

type AnyRecord = Record<string, any>;

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

export interface SfuProducer {
  id: string;
  kind: 'audio' | 'video';
  paused: boolean;
  userId: string;
  peer: SfuPeer;
}

export interface SfuPeer {
  socket: FakeWebSocket;
  userId: string;
  roomId: string;
  sessionId?: string;
  transports: Set<string>;
  producers: Map<string, SfuProducer>;
  /** consumerId -> producerId */
  consumers: Map<string, string>;
}

export interface FakeSfuOptions {
  /** Expected token; `null` runs the server without authentication. */
  token?: string | null;
  /** Delay (ms) before each reply or notification is delivered. */
  latencyMs?: number;
}

/** A rule that overrides the reply to the next matching request. */
export interface RequestOverride {
  type: string;
  /** Reply with this error instead. */
  error?: string;
  /** Never reply (the request times out or is failed by a close). */
  hang?: boolean;
  /** Reply with this data instead of the normal answer. */
  data?: unknown;
  /** Run before the normal handling; may mutate the SFU (e.g. drop a socket). */
  before?: (socket: FakeWebSocket, message: AnyRecord) => void;
  /** How many requests it applies to (default 1). */
  times?: number;
}

export class FakeSfu {
  readonly token: string | null;
  latencyMs: number;
  /** Every socket ever opened, in order. */
  readonly sockets: FakeWebSocket[] = [];
  readonly peers = new Map<FakeWebSocket, SfuPeer>();
  readonly overrides: RequestOverride[] = [];
  /** Hosts that never finish opening (the connection hangs). */
  readonly unreachableHosts = new Set<string>();
  /** A WebSocket constructor bound to this SFU, for `WebSocketImpl`. */
  readonly WebSocket: new (
    url: string,
  ) => WebSocket;

  constructor(options: FakeSfuOptions = {}) {
    this.token = options.token === undefined ? 'secret' : options.token;
    this.latencyMs = options.latencyMs ?? 0;
    const sfu = this;
    this.WebSocket = class BoundFakeWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url, sfu);
      }
    } as unknown as new (
      url: string,
    ) => WebSocket;
  }

  /** Override the reply to the next request(s) of a type. */
  override(rule: RequestOverride): void {
    this.overrides.push({ times: 1, ...rule });
  }

  /** The most recent socket. */
  get lastSocket(): FakeWebSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('No socket has been opened.');
    return socket;
  }

  /** Producers of a user in a room. */
  producersOf(userId: string): SfuProducer[] {
    const out: SfuProducer[] = [];
    for (const peer of this.peers.values()) {
      if (peer.userId === userId) out.push(...peer.producers.values());
    }
    return out;
  }

  /** All requests of a type sent on any socket, in order. */
  requests(type: string): AnyRecord[] {
    return this.sockets.flatMap((s) => s.sent.filter((m) => m.type === type));
  }

  deliver(socket: FakeWebSocket, message: AnyRecord): void {
    const send = () => socket.receive(message);
    setTimeout(send, this.latencyMs);
  }

  /** Called by FakeWebSocket#send. */
  handle(socket: FakeWebSocket, message: AnyRecord) {
    const { type, requestId } = message;
    const reply = (data: unknown) => this.deliver(socket, { requestId, data });
    const fail = (error: string) => this.deliver(socket, { requestId, error });

    const rule = this.overrides.find((o) => o.type === type);
    if (rule) {
      rule.times = (rule.times ?? 1) - 1;
      if (rule.times <= 0) this.overrides.splice(this.overrides.indexOf(rule), 1);
      rule.before?.(socket, message);
      if (rule.hang) return;
      if (rule.error !== undefined) {
        fail(rule.error);
        return;
      }
      if (rule.data !== undefined) {
        reply(rule.data);
        return;
      }
    }
    if (socket.readyState !== WS_OPEN) return;

    let peer = this.peers.get(socket);
    if (type === 'authenticate') {
      if (peer) return fail('Already authenticated');
      if (this.token !== null && message.token !== this.token) {
        return fail('Invalid authentication token');
      }
      const roomId = typeof message.roomId === 'string' ? message.roomId : 'default';
      const userId = String(message.userId ?? '');
      const duplicates = [...this.peers.values()].filter(
        (p) => p.userId === userId && p.roomId === roomId,
      );
      if (
        message.reconnect === true &&
        duplicates.some((p) => !message.sessionId || p.sessionId !== message.sessionId)
      ) {
        return fail(`User ${userId} is already connected from another session`);
      }
      for (const old of duplicates) {
        this.removePeer(old);
        old.socket.serverClose(4001, 'Replaced by a newer connection for the same user');
      }
      peer = {
        socket,
        userId,
        roomId,
        sessionId: message.sessionId,
        transports: new Set(),
        producers: new Map(),
        consumers: new Map(),
      };
      this.peers.set(socket, peer);
      return reply({});
    }
    if (!peer) return fail('Not authenticated');

    switch (type) {
      case 'getRouterRtpCapabilities':
        return reply(testFakeParameters.generateRouterRtpCapabilities());
      case 'createWebRtcTransport': {
        const params = testFakeParameters.generateTransportRemoteParameters();
        peer.transports.add(params.id);
        return reply(params);
      }
      case 'connectTransport':
        if (!peer.transports.has(message.transportId)) {
          return fail(`Transport not found: ${message.transportId}`);
        }
        return reply({});
      case 'restartIce':
        if (!peer.transports.has(message.transportId)) {
          return fail(`Transport not found: ${message.transportId}`);
        }
        return reply({
          iceParameters: testFakeParameters.generateTransportRemoteParameters().iceParameters,
        });
      case 'produce': {
        if (!peer.transports.has(message.transportId)) {
          return fail(`Transport not found: ${message.transportId}`);
        }
        if (message.kind !== 'audio' && message.kind !== 'video') {
          return fail(`Invalid media kind: ${message.kind}`);
        }
        const id = testFakeParameters.generateProducerRemoteParameters().id;
        const producer: SfuProducer = {
          id,
          kind: message.kind,
          paused: message.paused === true,
          userId: peer.userId,
          peer,
        };
        peer.producers.set(id, producer);
        reply({ id });
        this.broadcast(peer, {
          type: 'newProducer',
          producerId: id,
          userId: peer.userId,
          kind: producer.kind,
          paused: producer.paused,
        });
        return;
      }
      case 'getProducers': {
        const producers = [];
        for (const other of this.peers.values()) {
          if (other === peer || other.roomId !== peer.roomId) continue;
          for (const p of other.producers.values()) {
            producers.push({ producerId: p.id, userId: p.userId, kind: p.kind, paused: p.paused });
          }
        }
        return reply({ producers });
      }
      case 'closeProducer': {
        const producer = peer.producers.get(message.producerId);
        if (!producer) return fail(`Producer not found: ${message.producerId}`);
        peer.producers.delete(producer.id);
        this.broadcast(peer, { type: 'producerClosed', producerId: producer.id });
        return reply({});
      }
      case 'pauseProducer':
      case 'resumeProducer': {
        const producer = peer.producers.get(message.producerId);
        if (!producer) return fail(`Producer not found: ${message.producerId}`);
        const paused = type === 'pauseProducer';
        if (producer.paused !== paused) {
          producer.paused = paused;
          this.notifyConsumers(producer, paused ? 'producerPaused' : 'producerResumed');
        }
        return reply({});
      }
      case 'consume': {
        if (!peer.transports.has(message.transportId)) {
          return fail(`Transport not found: ${message.transportId}`);
        }
        const producer = this.findProducer(peer.roomId, message.producerId);
        if (!producer) return fail(`Producer not found: ${message.producerId}`);
        const caps = message.rtpCapabilities;
        if (!caps || !Array.isArray(caps.codecs) || caps.codecs.length === 0) {
          return fail('Cannot consume: invalid rtpCapabilities');
        }
        const params = testFakeParameters.generateConsumerRemoteParameters({
          codecMimeType: producer.kind === 'audio' ? 'audio/opus' : 'video/VP8',
        });
        peer.consumers.set(params.id, producer.id);
        return reply({
          id: params.id,
          producerId: producer.id,
          kind: producer.kind,
          rtpParameters: params.rtpParameters,
          producerPaused: producer.paused,
        });
      }
      case 'consumerResume':
        if (!peer.consumers.has(message.consumerId)) {
          return fail(`Consumer not found: ${message.consumerId}`);
        }
        return reply({});
      case 'closeConsumer':
        if (!peer.consumers.delete(message.consumerId)) {
          return fail(`Consumer not found: ${message.consumerId}`);
        }
        return reply({});
      default:
        return fail(`Unknown method: ${type}`);
    }
  }

  findProducer(roomId: string, producerId: string): SfuProducer | undefined {
    for (const peer of this.peers.values()) {
      if (peer.roomId !== roomId) continue;
      const producer = peer.producers.get(producerId);
      if (producer) return producer;
    }
    return undefined;
  }

  broadcast(from: SfuPeer, message: AnyRecord): void {
    for (const other of this.peers.values()) {
      if (other !== from && other.roomId === from.roomId) this.deliver(other.socket, message);
    }
  }

  notifyConsumers(producer: SfuProducer, type: 'producerPaused' | 'producerResumed'): void {
    for (const peer of this.peers.values()) {
      for (const producerId of peer.consumers.values()) {
        if (producerId === producer.id) {
          this.deliver(peer.socket, { type, producerId: producer.id });
        }
      }
    }
  }

  removePeer(peer: SfuPeer): void {
    if (!this.peers.delete(peer.socket)) return;
    for (const producer of peer.producers.values()) {
      this.broadcast(peer, { type: 'producerClosed', producerId: producer.id });
    }
    peer.producers.clear();
  }

  /** Called when a socket closes, from either side. */
  onSocketClosed(socket: FakeWebSocket): void {
    const peer = this.peers.get(socket);
    if (peer) this.removePeer(peer);
  }
}

/** A WebSocket that talks to a {@link FakeSfu}. */
export class FakeWebSocket {
  readonly url: string;
  readonly sfu: FakeSfu;
  readyState = WS_CONNECTING;
  /** Every frame the client sent, parsed. */
  readonly sent: AnyRecord[] = [];
  /** Frames delivered to the client (responses and notifications). */
  readonly received: AnyRecord[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  closedByClient = false;

  constructor(url: string, sfu: FakeSfu) {
    this.url = url;
    this.sfu = sfu;
    sfu.sockets.push(this);
    const host = new URL(url).host;
    setTimeout(() => {
      if (this.readyState !== WS_CONNECTING || sfu.unreachableHosts.has(host)) return;
      this.readyState = WS_OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(raw: string): void {
    if (this.readyState !== WS_OPEN) throw new Error('WebSocket is not open');
    const message = JSON.parse(raw);
    this.sent.push(message);
    this.sfu.handle(this, message);
  }

  /** The client closed the socket. */
  close(code = 1000, reason = ''): void {
    if (this.readyState === WS_CLOSED) return;
    this.closedByClient = true;
    this.readyState = WS_CLOSED;
    this.sfu.onSocketClosed(this);
    const onclose = this.onclose;
    setTimeout(() => onclose?.({ code, reason, wasClean: true }), 0);
  }

  /** The server (or the network) closed the socket. 1006 = abnormal, unclean. */
  serverClose(code = 1006, reason = ''): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.sfu.onSocketClosed(this);
    if (code === 1006) this.onerror?.({});
    this.onclose?.({ code, reason, wasClean: code !== 1006 });
  }

  /** Deliver a server frame to the client. */
  receive(message: AnyRecord): void {
    if (this.readyState !== WS_OPEN) return;
    this.received.push(message);
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Requests of a type this socket sent. */
  requests(type: string): AnyRecord[] {
    return this.sent.filter((m) => m.type === type);
  }
}
