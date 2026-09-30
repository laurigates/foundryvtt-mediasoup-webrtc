/**
 * e2e host: just enough of a Foundry VTT v14 client to boot the real
 * dist/mediasoup-vtt.mjs and drive it the way core drives an A/V client.
 *
 * Written against the public v14 API documentation (foundryvtt.com/api:
 * foundry.av.AVClient, AVMaster, AVSettings, CameraViews, ClientSettings,
 * Hooks) and the behaviour the module relies on. Only the members the module
 * calls exist, and each does the simplest thing that honours its documented
 * contract. Anything core decides internally (voice-level analysis,
 * push-to-talk key handling) is NOT reproduced: the specs flip those
 * decisions directly through `__e2e.speak()` and `__e2e.pushToTalk()` and
 * assert what the module does with them.
 *
 * Boot: import the module's `esmodules` (from its module.json), fire `init`,
 * `i18nInit`, `setup`, create `game.webrtc` (which instantiates
 * CONFIG.WebRTC.clientClass) and `ui.webrtc`, fire `ready`. The spec then
 * calls `__e2e.connect()` (game.webrtc.connect(): client initialize() +
 * connect()), so it can sequence several peers.
 *
 * Query parameters: user, users (comma list of world users, all active),
 * world, sfu (server URL), token, voice (always|activity|ptt), avMode (0-3).
 */

const query = new URLSearchParams(location.search);
const SELF = query.get('user') ?? 'userA';
const WORLD_USERS = [SELF, ...(query.get('users') ?? '').split(',')].filter(
  (id, i, all) => id && all.indexOf(id) === i,
);
const WORLD = query.get('world') ?? 'e2e-world';
const MODULE = 'mediasoup-vtt';

/** Probe state for the specs. */
const e2e = {
  ready: false,
  bootError: null,
  boot: {},
  hookCalls: [],
  hookErrors: [],
  notifications: [],
  activity: [],
  levelReports: [],
  consoleErrors: [],
  pageErrors: [],
  transportStates: [],
  consumerEvents: [],
  renders: 0,
};
window.__e2e = e2e;

for (const level of ['error', 'warn']) {
  const write = console[level].bind(console);
  console[level] = (...args) => {
    e2e.consoleErrors.push({ level, text: args.map(String).join(' ') });
    write(...args);
  };
}
window.addEventListener('error', (ev) => e2e.pageErrors.push(String(ev.error ?? ev.message)));
window.addEventListener('unhandledrejection', (ev) =>
  e2e.pageErrors.push(String(ev.reason?.stack ?? ev.reason)),
);

/* ---------------- small helpers ---------------- */

const copy = (value) => (value === undefined ? undefined : structuredClone(value));
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Last call wins after `ms` of quiet. */
function settle(fn, ms) {
  let handle = 0;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(fn, ms, ...args);
  };
}

/** Nested object holding only the leaves of `next` that differ from `prev`. */
function delta(prev, next) {
  const out = {};
  for (const [key, value] of Object.entries(next ?? {})) {
    const old = prev?.[key];
    if (isRecord(old) && isRecord(value)) {
      const sub = delta(old, value);
      if (Object.keys(sub).length > 0) out[key] = sub;
    } else if (JSON.stringify(old) !== JSON.stringify(value)) {
      out[key] = copy(value);
    }
  }
  return out;
}

/** "a.b.c" -> nested assignment, creating objects on the way. */
function assignPath(root, dotted, value) {
  const keys = dotted.split('.');
  const leaf = keys.pop();
  let node = root;
  for (const k of keys) {
    if (!isRecord(node[k])) node[k] = {};
    node = node[k];
  }
  node[leaf] = value;
}

const readPath = (root, dotted) => dotted.split('.').reduce((node, k) => node?.[k], root);

/** { a: { b: 1 } } -> { 'a.b': 1 } */
function leaves(obj, base = '') {
  return Object.entries(obj ?? {}).reduce((acc, [k, v]) => {
    const path = base ? `${base}.${k}` : k;
    if (isRecord(v) && Object.keys(v).length) Object.assign(acc, leaves(v, path));
    else acc[path] = v;
    return acc;
  }, {});
}

/* ---------------- Hooks ---------------- */

const hookTable = {};
let hookSerial = 0;

function fire(name, args, cancellable) {
  e2e.hookCalls.push(name);
  const listeners = hookTable[name] ?? [];
  hookTable[name] = listeners.filter((l) => !l.once);
  for (const listener of listeners) {
    let result;
    try {
      result = listener.fn(...args);
    } catch (err) {
      e2e.hookErrors.push({ hook: name, error: String(err?.stack ?? err) });
      console.error(`[e2e host] "${name}" hook handler threw:`, err);
      continue;
    }
    if (cancellable && result === false) return false;
  }
  return true;
}

window.Hooks = {
  /** Registered listeners by hook name. */
  get events() {
    return hookTable;
  },
  on(name, fn, opts = {}) {
    hookSerial += 1;
    hookTable[name] = [
      ...(hookTable[name] ?? []),
      { id: hookSerial, fn, once: opts.once === true },
    ];
    return hookSerial;
  },
  once(name, fn) {
    return window.Hooks.on(name, fn, { once: true });
  },
  off(name, fnOrId) {
    const byId = typeof fnOrId === 'number';
    hookTable[name] = (hookTable[name] ?? []).filter((l) =>
      byId ? l.id !== fnOrId : l.fn !== fnOrId,
    );
  },
  callAll: (name, ...args) => fire(name, args, false),
  call: (name, ...args) => fire(name, args, true),
};

/* ---------------- game ---------------- */

/** Iterates its values, like foundry.utils.Collection. */
class ValueMap extends Map {
  *[Symbol.iterator]() {
    for (const [, value] of this.entries()) yield value;
  }
}

const people = new ValueMap(
  WORLD_USERS.map((id, i) => [
    id,
    {
      id,
      name: id,
      active: true,
      isGM: i === 0,
      isSelf: id === SELF,
      can: () => true,
      broadcastActivity: (payload) => e2e.activity.push(copy(payload)),
    },
  ]),
);

/** Persisted values of every setting, keyed "namespace.key". */
const stored = new Map([
  [`${MODULE}.mediaSoupServerUrl`, query.get('sfu') ?? ''],
  [`${MODULE}.mediaSoupAuthToken`, query.get('token') ?? ''],
]);

const gameSettings = {
  settings: new Map(),
  menus: new Map(),
  register(ns, key, config) {
    gameSettings.settings.set(`${ns}.${key}`, { ...config, namespace: ns, key });
  },
  registerMenu(ns, key, config) {
    gameSettings.menus.set(`${ns}.${key}`, { ...config, namespace: ns, key });
  },
  lookup(ns, key) {
    const entry = gameSettings.settings.get(`${ns}.${key}`);
    if (!entry) throw new Error(`Setting ${ns}.${key} was never registered`);
    return entry;
  },
  get(ns, key) {
    const entry = gameSettings.lookup(ns, key);
    const id = `${ns}.${key}`;
    return copy(stored.has(id) ? stored.get(id) : entry.default);
  },
  async set(ns, key, value) {
    const entry = gameSettings.lookup(ns, key);
    stored.set(`${ns}.${key}`, copy(value));
    entry.onChange?.(copy(value));
    return value;
  },
};

let strings = {};
const i18n = {
  lang: 'en',
  has: (key) => typeof strings[key] === 'string',
  localize: (key) => strings[key] ?? key,
  format(key, data = {}) {
    return i18n.localize(key).replace(/\{(\w+)\}/g, (all, name) => data[name] ?? all);
  },
};

const notifications = Object.fromEntries(
  ['info', 'warn', 'error', 'success'].map((level) => [
    level,
    (message, options) => {
      e2e.notifications.push({ level, message: String(message), options: options ?? null });
      return { id: e2e.notifications.length };
    },
  ]),
);

window.game = {
  userId: SELF,
  user: people.get(SELF),
  users: people,
  world: { id: WORLD, title: WORLD },
  settings: gameSettings,
  i18n,
};

/* ---------------- foundry.av ---------------- */

const MODES = Object.freeze({ DISABLED: 0, AUDIO: 1, VIDEO: 2, AUDIO_VIDEO: 3 });
const PER_USER_DEFAULTS = Object.freeze({
  popout: false,
  volume: 1,
  muted: false,
  hidden: false,
  blocked: false,
});

async function devicesOfKind(kind) {
  const list = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  return Object.fromEntries(
    list.filter((d) => d.kind === kind).map((d) => [d.deviceId, d.label || d.deviceId]),
  );
}

/** The abstract A/V client. Every member a subclass must supply throws here. */
class AVClient {
  constructor(master, settings) {
    Object.assign(this, { master, settings });
  }
  #voiceIs(mode) {
    return this.settings.get('client', 'voice.mode') === mode;
  }
  get isVoicePTT() {
    return this.#voiceIs('ptt');
  }
  get isVoiceAlways() {
    return this.#voiceIs('always');
  }
  get isVoiceActivated() {
    return this.#voiceIs('activity');
  }
  get isMuted() {
    return this.settings.getUser(game.userId)?.muted === true;
  }
  getAudioSinks() {
    return devicesOfKind('audiooutput');
  }
  getAudioSources() {
    return devicesOfKind('audioinput');
  }
  getVideoSources() {
    return devicesOfKind('videoinput');
  }
  onSettingsChanged() {}
}
const SUBCLASS_DUTIES = {
  initialize: true,
  connect: true,
  disconnect: true,
  setUserVideo: true,
  updateLocalStream: true,
  getConnectedUsers: false,
  getMediaStreamForUser: false,
  getLevelsStreamForUser: false,
  isAudioEnabled: false,
  isVideoEnabled: false,
  toggleAudio: false,
  toggleBroadcast: false,
  toggleVideo: false,
};
for (const [name, returnsPromise] of Object.entries(SUBCLASS_DUTIES)) {
  const fail = () => {
    throw new Error(`AVClient#${name} is abstract (e2e host)`);
  };
  AVClient.prototype[name] = returnsPromise ? async () => fail() : fail;
}
e2e.abstractMethods = Object.keys(SUBCLASS_DUTIES);

/** Placeholder for the stock client, so a spec can tell it was replaced. */
class SimplePeerAVClient extends AVClient {}

/**
 * World and client A/V settings, stored as two core settings. `set()` edits
 * in memory, persists shortly after, and the persisted change comes back
 * through `changed()` as a diff to AVMaster and the client.
 */
class AVSettings {
  static AV_MODES = MODES;
  static VOICE_MODES = { ALWAYS: 'always', ACTIVITY: 'activity', PTT: 'ptt' };
  static DOCK_POSITIONS = { TOP: 'top', RIGHT: 'right', BOTTOM: 'bottom', LEFT: 'left' };
  static NAMEPLATE_MODES = { OFF: 0, BOTH: 1, PLAYER_ONLY: 2, CHAR_ONLY: 3 };
  static get DEFAULT_USER_SETTINGS() {
    return { ...PER_USER_DEFAULTS };
  }

  static register() {
    const reload = () => game.webrtc?.settings.changed();
    gameSettings.register('core', 'rtcWorldSettings', {
      scope: 'world',
      default: { mode: Number(query.get('avMode') ?? MODES.AUDIO_VIDEO) },
      onChange: reload,
    });
    gameSettings.register('core', 'rtcClientSettings', {
      scope: 'client',
      default: {
        audioSrc: 'default',
        videoSrc: 'default',
        audioSink: 'default',
        muteAll: false,
        disableVideo: false,
        dockPosition: 'left',
        nameplates: 1,
        voice: { mode: query.get('voice') ?? 'always' },
        users: {},
      },
      onChange: reload,
    });
  }

  /** Transient per-user state reported by the users themselves. */
  activity = { [SELF]: {} };
  #snapshot;
  #persist;

  constructor() {
    this.#load();
    this.changed = settle(() => this.#reloaded(), 50);
    this.#persist = settle((scope) => {
      const key = scope === 'world' ? 'rtcWorldSettings' : 'rtcClientSettings';
      gameSettings.set('core', key, this[scope]);
    }, 50);
    const self = this.getUser(SELF);
    game.user.broadcastActivity({ av: { hidden: self.hidden, muted: self.muted } });
  }

  #load() {
    this.world = gameSettings.get('core', 'rtcWorldSettings');
    this.client = gameSettings.get('core', 'rtcClientSettings');
    this.#snapshot = copy({ world: this.world, client: this.client });
  }

  #reloaded() {
    const before = this.#snapshot;
    this.#load();
    const diff = delta(before, this.#snapshot);
    e2e.lastSettingsChange = diff;
    game.webrtc.onSettingsChanged(diff);
    window.Hooks.callAll('rtcSettingsChanged', this, diff);
  }

  get(scope, path) {
    return readPath(this[scope], path);
  }

  set(scope, path, value) {
    assignPath(this[scope], path, value);
    this.#persist(scope);
  }

  getUser(userId) {
    if (!game.users.get(userId)) return null;
    const own = this.client.users?.[userId] ?? {};
    const reported = userId === SELF ? {} : (this.activity[userId] ?? {});
    return {
      ...PER_USER_DEFAULTS,
      ...own,
      muted: own.muted === true || reported.muted === true,
      hidden: own.hidden === true || reported.hidden === true,
      canBroadcastAudio: true,
      canBroadcastVideo: true,
      speaking: this.activity[userId]?.speaking === true,
    };
  }

  get users() {
    return Object.fromEntries([...game.users.keys()].map((id) => [id, this.getUser(id)]));
  }

  get verticalDock() {
    return this.client.dockPosition === 'left' || this.client.dockPosition === 'right';
  }

  handleUserActivity(userId, data) {
    this.activity[userId] = { ...this.activity[userId], ...data };
    if ('speaking' in data) ui.webrtc?.setUserIsSpeaking(userId, data.speaking);
  }
}

/**
 * game.webrtc. Owns the client's lifecycle and the broadcast decision.
 * Voice detection is a test double: it records which levels stream it would
 * monitor and arms `__e2e.speak()`; it does no audio analysis.
 */
class AVMaster {
  #live = false;
  #opening = null;
  /** The levels stream voice activation watches, while armed. */
  #watching = null;

  constructor() {
    const settings = new AVSettings();
    const Client = CONFIG.WebRTC.clientClass;
    Object.assign(this, { settings, broadcasting: false });
    this.client = new Client(this, settings);
  }

  get mode() {
    return this.settings.get('world', 'mode');
  }

  get isLive() {
    return this.#live;
  }

  connect() {
    this.#opening ??= this.#open().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async #open() {
    const enabled = this.mode !== MODES.DISABLED;
    await this.disconnect();
    if (!enabled) return false;
    await this.client.initialize();
    if (!(await this.client.connect())) return false;
    this.#live = true;
    this.#startSession();
    return true;
  }

  /** First state after a successful connect: devices, voice mode, dock. */
  #startSession() {
    const me = game.userId;
    const prefs = this.settings.client;
    const alwaysOn = prefs.voice.mode === 'always';
    this._initializeUserVoiceDetection(prefs.voice.mode);
    this.client.toggleAudio(alwaysOn && this.canUserShareAudio(me));
    this.client.toggleVideo(this.canUserShareVideo(me));
    this.broadcast(alwaysOn);
    this.render();
  }

  async disconnect() {
    if (!this.#live) return false;
    this.#live = false;
    await this.client.disconnect();
    return true;
  }

  async reestablish() {
    if (this.#live) await this.connect();
  }

  #modeAllows(kind) {
    const both = this.mode === MODES.AUDIO_VIDEO;
    return both || this.mode === (kind === 'audio' ? MODES.AUDIO : MODES.VIDEO);
  }

  canUserBroadcastAudio(id) {
    return this.#modeAllows('audio') && this.settings.getUser(id)?.canBroadcastAudio === true;
  }

  canUserBroadcastVideo(id) {
    return this.#modeAllows('video') && this.settings.getUser(id)?.canBroadcastVideo === true;
  }

  canUserShareAudio(userId) {
    const u = this.settings.getUser(userId);
    return this.canUserBroadcastAudio(userId) && !u.muted && !u.blocked;
  }

  canUserShareVideo(userId) {
    const u = this.settings.getUser(userId);
    return this.canUserBroadcastVideo(userId) && !u.hidden && !u.blocked;
  }

  /** Broadcast if the user wants to and is allowed to (not muted). */
  broadcast(intent) {
    const me = game.userId;
    const on = !!intent && this.canUserShareAudio(me);
    this.broadcasting = on;
    this.client.toggleBroadcast(on);
    const mine = this.settings.activity[me];
    if (mine.speaking !== on) game.user.broadcastActivity({ av: { speaking: on } });
    mine.speaking = on;
    ui.webrtc.setUserIsSpeaking(me, on);
  }

  _initializeUserVoiceDetection(voiceMode) {
    if (voiceMode !== 'activity') return this.#disarm();
    this.activateVoiceDetection(this.client.getLevelsStreamForUser(game.userId));
  }

  activateVoiceDetection(stream) {
    this.#disarm();
    const audio = stream?.getAudioTracks() ?? [];
    e2e.levelReports.push({
      op: 'start',
      id: game.userId,
      audioTracks: audio.length,
      enabledAudioTracks: audio.filter((t) => t.enabled).length,
      liveAudioTracks: audio.filter((t) => t.readyState === 'live').length,
    });
    if (audio.some((t) => t.enabled && t.readyState === 'live')) this.#watching = stream;
  }

  deactivateVoiceDetection() {
    this.#disarm();
  }

  /** Disarm detection. Re-arming clears the local speaking indicator, which the module restores. */
  #disarm() {
    if (this.#watching) e2e.levelReports.push({ op: 'stop', id: game.userId });
    this.#watching = null;
    ui.webrtc?.setUserIsSpeaking(game.userId, false);
  }

  /** Test control behind `__e2e.speak()`: the voice detector's verdict. */
  e2eVoiceVerdict(speaking) {
    if (!this.#live || !this.#watching) return false;
    this.broadcast(speaking);
    return true;
  }

  render() {
    return ui.webrtc?.render();
  }

  /**
   * A world change reconnects; everything else is the client's job (the
   * module must apply mute, hide, devices and voice mode itself).
   */
  onSettingsChanged(changed) {
    if (changed.world) return this.connect();
    this.client.onSettingsChanged(changed);
  }
}

/** ui.webrtc: one `.camera-view[data-user] > video.user-camera` per connected user. */
class CameraViews {
  #queued = null;

  constructor() {
    this.element = document.getElementById('camera-views');
  }

  get rendered() {
    return true;
  }

  getUserCameraView(userId) {
    return this.element.querySelector(`.camera-view[data-user="${userId}"]`);
  }

  getUserVideoElement(userId) {
    const view = this.getUserCameraView(userId);
    return view ? view.querySelector('video.user-camera') : null;
  }

  setUserIsSpeaking(userId, on) {
    const view = this.getUserCameraView(userId);
    if (view) view.classList.toggle('speaking', on === true);
  }

  /** Renders are batched into one pass per microtask. */
  render() {
    this.#queued ??= Promise.resolve().then(() => {
      this.#queued = null;
      return this.#paint();
    });
    return this.#queued;
  }

  async #paint() {
    const master = game.webrtc;
    if (master.mode === MODES.DISABLED) return this;
    e2e.renders += 1;
    const wanted = master.client.getConnectedUsers();
    for (const view of this.element.querySelectorAll('.camera-view')) {
      if (!wanted.includes(view.dataset.user)) view.remove();
    }
    for (const userId of wanted) {
      if (!this.getUserCameraView(userId)) this.element.append(this.#tile(userId));
      this.setUserIsSpeaking(userId, master.settings.activity[userId]?.speaking);
      await master.client.setUserVideo(userId, this.getUserVideoElement(userId));
    }
    return this;
  }

  #tile(userId) {
    const view = Object.assign(document.createElement('div'), { className: 'camera-view' });
    view.dataset.user = userId;
    const video = Object.assign(document.createElement('video'), {
      className: userId === SELF ? 'user-camera local-camera' : 'user-camera',
      autoplay: true,
      playsInline: true,
      width: 160,
      height: 120,
    });
    view.append(video);
    return view;
  }
}

/* ---------------- foundry.applications (config menu) ---------------- */

class ApplicationV2 {
  static DEFAULT_OPTIONS = {};
  constructor(options = {}) {
    this.options = options;
  }
  get id() {
    return this.constructor.DEFAULT_OPTIONS?.id ?? 'app';
  }
  async _prepareContext() {
    return {};
  }
  async render() {
    return this;
  }
}
const HandlebarsApplicationMixin = (Base) =>
  class extends Base {
    static PARTS = {};
  };

window.foundry = {
  utils: { flattenObject: (obj) => leaves(obj) },
  av: { AVClient, AVMaster, AVSettings, clients: { SimplePeerAVClient } },
  applications: { api: { ApplicationV2, HandlebarsApplicationMixin } },
};
window.CONFIG = { WebRTC: { clientClass: SimplePeerAVClient } };
window.ui = { notifications };

/* ---------------- probes ---------------- */

const transport = () => game.webrtc?.client?.transport;

/** [consumerId, consumer] pairs this page holds for a remote user. */
function consumersOf(userId) {
  const t = transport();
  if (!t) return [];
  return [...t.consumers].filter(([id]) => t.consumerToUserMap.get(id) === userId);
}

function remoteConsumers(userId) {
  return consumersOf(userId).map(([consumerId, c]) => ({
    consumerId,
    producerId: c.producerId,
    kind: c.kind,
    closed: c.closed,
    trackState: c.track?.readyState,
    producerPaused: c.appData?.producerPaused === true,
  }));
}

/** inbound-rtp counters per kind for a remote user's consumers. */
async function inbound(userId) {
  const out = {};
  for (const [consumerId, c] of consumersOf(userId)) {
    for (const s of (await c.getStats()).values()) {
      if (s.type !== 'inbound-rtp') continue;
      out[c.kind] = {
        consumerId,
        bytesReceived: s.bytesReceived ?? 0,
        packetsReceived: s.packetsReceived ?? 0,
        framesDecoded: s.framesDecoded ?? 0,
        frameWidth: s.frameWidth ?? 0,
        // Audio: Chromium's fake microphone beeps, while a disabled track
        // sends silence at the same packet rate, so energy tells them apart.
        totalAudioEnergy: s.totalAudioEnergy ?? 0,
        totalSamplesDuration: s.totalSamplesDuration ?? 0,
      };
    }
  }
  return out;
}

/** outbound-rtp counters per producer tag. */
async function outbound() {
  const out = {};
  for (const [tag, p] of transport()?.producers ?? []) {
    for (const s of (await p.getStats()).values()) {
      if (s.type !== 'outbound-rtp') continue;
      out[tag] = {
        producerId: p.id,
        paused: p.paused,
        bytesSent: s.bytesSent ?? 0,
        packetsSent: s.packetsSent ?? 0,
      };
    }
  }
  return out;
}

/** A user's dock tile, as the client last left it. */
function tile(userId) {
  const video = ui.webrtc?.getUserVideoElement(userId);
  if (!video) return { present: false };
  const stream = video.srcObject;
  const client = game.webrtc?.client;
  const d = video.dataset;
  return {
    present: true,
    hasStream: !!stream,
    isClientStream: !!stream && stream === client?.getMediaStreamForUser(userId),
    isLocalStream: !!stream && stream === client?.localStream,
    currentTime: video.currentTime,
    speaking: !!video.closest('.camera-view')?.classList.contains('speaking'),
    trackKinds: stream?.getTracks().map((t) => `${t.kind}:${t.readyState}`) ?? [],
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    readyState: video.readyState,
    paused: video.paused,
    muted: video.muted,
    audioPausedMarker: d.mediasoupAudioPaused === 'true',
    videoPausedMarker: d.mediasoupVideoPaused === 'true',
  };
}

/**
 * The tile's current frame scaled to 64x48 and reduced to luma. A disabled
 * camera sends uniform black; Chromium's fake camera draws a moving pattern.
 */
const lumaCanvas = document.createElement('canvas');
function frame(userId) {
  const video = ui.webrtc?.getUserVideoElement(userId);
  if (!video?.videoWidth || video.readyState < 2) return null;
  lumaCanvas.width = 64;
  lumaCanvas.height = 48;
  const ctx = lumaCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 64, 48);
  const rgba = ctx.getImageData(0, 0, 64, 48).data;
  const luma = [];
  for (let i = 0; i < rgba.length; i += 4) {
    luma.push(Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]));
  }
  const mean = luma.reduce((a, y) => a + y, 0) / luma.length;
  const std = Math.sqrt(luma.reduce((a, y) => a + (y - mean) ** 2, 0) / luma.length);
  return { mean, std, luma, currentTime: video.currentTime };
}

Object.assign(e2e, {
  userId: SELF,
  worldId: WORLD,
  connect: () => game.webrtc.connect(),
  disconnect: () => game.webrtc.disconnect(),
  render: () => ui.webrtc.render(),
  remoteConsumers,
  inbound,
  outbound,
  tile,
  frame,
  /**
   * Voice activation's verdict, set by the spec instead of measured: true
   * = the user is talking. False (nothing happens) unless detection is armed
   * on a levels stream with a live, enabled audio track.
   */
  speak: (speaking) => game.webrtc.e2eVoiceVerdict(speaking),
  /**
   * The push-to-talk key, pressed (true) or released (false). In "ptt" mode
   * it asks AVMaster to broadcast; the release takes effect at once.
   */
  pushToTalk(down) {
    const master = game.webrtc;
    if (!master?.isLive || master.settings.client.voice.mode !== 'ptt') return false;
    master.broadcast(down);
    return true;
  },
  status() {
    const client = game.webrtc?.client;
    const t = client?.transport;
    return {
      state: t?.state,
      isConnected: client?.isConnected === true,
      connectedUsers: client?.getConnectedUsers() ?? [],
      remoteUsers: t?.getRemoteUserIds() ?? [],
      producers: [...(t?.producers ?? [])].map(([tag, p]) => ({ tag, paused: p.paused })),
      audioEnabled: client?.isAudioEnabled() ?? false,
      videoEnabled: client?.isVideoEnabled() ?? false,
      broadcasting: game.webrtc?.broadcasting === true,
      localTracks: (client?.localStream?.getTracks() ?? []).map(
        (t) => `${t.kind}:${t.enabled ? 'enabled' : 'disabled'}`,
      ),
      renders: e2e.renders,
    };
  },
  /** Change an A/V client setting through AVSettings, as the A/V config does. */
  setClientSetting: (path, value) => game.webrtc.settings.set('client', path, value),
});

/* ---------------- boot ---------------- */

async function boot() {
  AVSettings.register();

  const base = `/modules/${MODULE}`;
  const manifest = await (await fetch(`${base}/module.json`)).json();
  e2e.boot.manifest = { id: manifest.id, esmodules: manifest.esmodules };
  const en = manifest.languages?.find((l) => l.lang === 'en');
  if (en) {
    const flat = leaves(await (await fetch(`${base}/${en.path}`)).json());
    strings = Object.fromEntries(Object.entries(flat).filter(([, v]) => typeof v === 'string'));
  }

  for (const entry of manifest.esmodules ?? []) await import(`/modules/${manifest.id}/${entry}`);
  e2e.boot.clientClassAfterImport = CONFIG.WebRTC.clientClass?.name ?? null;

  for (const hook of ['init', 'i18nInit', 'setup']) window.Hooks.callAll(hook);

  ui.webrtc = new CameraViews();
  game.webrtc = new AVMaster();

  const t = transport();
  t?.on?.('stateChanged', ({ state, previous }) =>
    e2e.transportStates.push({ state, previous, at: Date.now() }),
  );
  for (const event of ['consumerAdded', 'consumerRemoved']) {
    t?.on?.(event, ({ userId, kind, consumerId }) =>
      e2e.consumerEvents.push({ event, userId, kind, consumerId }),
    );
  }

  window.Hooks.callAll('ready');
  e2e.ready = true;
}

boot().catch((error) => {
  e2e.bootError = String(error?.stack ?? error);
  console.error('e2e host boot failed', error);
});
