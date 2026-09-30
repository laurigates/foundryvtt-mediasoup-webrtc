/**
 * Foundry VTT v14 test doubles for the unit suite.
 *
 * These are written for this repository from the public v14 API pages
 * (https://foundryvtt.com/api/v14/) and from what a module can observe at
 * runtime. They are not Foundry code and do not reproduce Foundry's logic.
 * Each double offers only the surface MediaSoupVTT touches, with the simplest
 * behaviour that lets a spec check the module's side of the contract:
 *
 * - `Hooks`: on/once/off/call/callAll with numeric ids. ApplicationV2 render
 *   hooks pass an HTMLElement.
 * - `game.settings`: `register`, `registerMenu`, `get`, `set`, with the
 *   registered configs in the `settings` / `menus` Maps. Stored values live
 *   in `values`, a test-only Map.
 * - `foundry.av.AVClient`: the documented members. Those the page marks
 *   "Abstract" throw until a subclass overrides them.
 * - `foundry.av.AVSettings`: plain `client` / `world` objects built from the
 *   test's options. `set()` applies at once and reports the keys it set, as a
 *   nested object, to `game.webrtc.onSettingsChanged()` on a later task.
 * - `foundry.av.AVMaster`: connect/disconnect around the client, the
 *   `canUser*` permission checks, `broadcast()`, and a voice-detection stand-in
 *   whose level handler is a plain threshold. The members specs assert on are
 *   `vi.fn` spies.
 * - `game.audio` (level reports recorded), `ui.webrtc` (render hands each
 *   test-provided `<video>` to `setUserVideo`, speaking state recorded), and
 *   `foundry.applications.api.{ApplicationV2, HandlebarsApplicationMixin}`.
 *
 * `installFoundryV14()` puts the globals in place. It runs from
 * `tests/setup.ts`, before any spec imports `src/`, because
 * `MediaSoupAVClient` extends `foundry.av.AVClient` when it is evaluated.
 */

import { type Mock, vi } from 'vitest';
import en from '../../../lang/en.json';

type AnyRecord = Record<string, any>;

/** The installed globals, read at call time so each spec file sees its own. */
function globals(): { game: AnyRecord; ui: AnyRecord; Hooks: HooksRegistry } {
  return globalThis as any;
}

/** The id of the user this client runs as. */
function selfId(): string {
  return globals().game.user.id;
}

// ==== Object helpers ====

/** Read a dotted path (`a.b.c`) from an object; undefined when a step is missing. */
export function getProperty(object: any, path: string): any {
  return path
    .split('.')
    .reduce(
      (node, step) => (node !== null && typeof node === 'object' ? node[step] : undefined),
      object,
    );
}

/** Write a dotted path, creating the intermediate objects. */
export function setProperty(object: AnyRecord, path: string, value: unknown): void {
  const steps = path.split('.');
  const leaf = steps.pop() as string;
  let node = object;
  for (const step of steps) {
    if (node[step] === null || typeof node[step] !== 'object') node[step] = {};
    node = node[step];
  }
  node[leaf] = value;
}

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A new object with `extra` merged over `base`, recursing into nested records. */
export function mergeObject(base: AnyRecord, extra: AnyRecord): AnyRecord {
  const merged: AnyRecord = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    merged[key] =
      isRecord(value) && isRecord(merged[key]) ? mergeObject(merged[key], value) : value;
  }
  return merged;
}

// ==== Hooks ====

export interface HookedFunction {
  hook: string;
  id: number;
  fn: (...args: any[]) => any;
  once: boolean;
}

/** The `Hooks` API, as an instance so each spec file gets its own registry. */
export class HooksRegistry {
  /** hook name -> registered functions, in registration order. */
  readonly events: Record<string, HookedFunction[]> = {};
  #lastId = 0;

  #add(hook: string, fn: (...args: any[]) => any, once: boolean): number {
    if (typeof fn !== 'function') throw new TypeError(`Hooks: "${hook}" handler is not a function`);
    const entry: HookedFunction = { hook, id: ++this.#lastId, fn, once };
    this.events[hook] = [...(this.events[hook] ?? []), entry];
    return entry.id;
  }

  on(hook: string, fn: (...args: any[]) => any, options: { once?: boolean } = {}): number {
    return this.#add(hook, fn, options.once === true);
  }

  once(hook: string, fn: (...args: any[]) => any): number {
    return this.#add(hook, fn, true);
  }

  off(hook: string, fn: number | ((...args: any[]) => any)): void {
    const matches = (h: HookedFunction) => (typeof fn === 'number' ? h.id === fn : h.fn === fn);
    const list = this.events[hook] ?? [];
    const target = list.find(matches);
    if (target) this.events[hook] = list.filter((h) => h !== target);
  }

  /** Run the handlers in order; one that returns `false` stops the rest. */
  call(hook: string, ...args: any[]): boolean {
    for (const entry of this.handlers(hook)) {
      if (entry.once) this.off(hook, entry.id);
      if (entry.fn(...args) === false) return false;
    }
    return true;
  }

  /** Run every handler, whatever they return. */
  callAll(hook: string, ...args: any[]): true {
    for (const entry of this.handlers(hook)) {
      if (entry.once) this.off(hook, entry.id);
      entry.fn(...args);
    }
    return true;
  }

  /** Test helper: the handlers currently registered for a hook. */
  handlers(hook: string): HookedFunction[] {
    return [...(this.events[hook] ?? [])];
  }

  /** Test helper: every hook name that has at least one handler. */
  hookNames(): string[] {
    return Object.keys(this.events).filter((name) => this.handlers(name).length > 0);
  }
}

// ==== game.settings ====

const SETTING_SCOPES = new Set(['world', 'client', 'user']);

export class ClientSettingsFake {
  /** Registered setting configs keyed by `namespace.key`. */
  readonly settings = new Map<string, AnyRecord>();
  /** Registered menus keyed by `namespace.key`. */
  readonly menus = new Map<string, AnyRecord>();
  /** Test-only: the stored values keyed by `namespace.key`. */
  readonly values = new Map<string, unknown>();

  static #qualify(namespace: string, key: string, what: string): string {
    const qualified = `${namespace ?? ''}.${key ?? ''}`;
    if (qualified.startsWith('.') || qualified.endsWith('.')) {
      throw new Error(`${what} id "${qualified}" is incomplete`);
    }
    return qualified;
  }

  #config(namespace: string, key: string): [string, AnyRecord] {
    const qualified = ClientSettingsFake.#qualify(namespace, key, 'A setting');
    const config = this.settings.get(qualified);
    if (!config) throw new Error(`Setting ${qualified} was never registered`);
    return [qualified, config];
  }

  register(namespace: string, key: string, data: AnyRecord): void {
    const qualified = ClientSettingsFake.#qualify(namespace, key, 'A setting');
    const scope = data.scope ?? 'client';
    if (!SETTING_SCOPES.has(scope)) throw new Error(`Setting ${qualified}: bad scope ${scope}`);
    this.settings.set(qualified, { ...data, namespace, key, id: qualified, scope });
  }

  /** v14 menus open an ApplicationV2; anything else is refused. */
  registerMenu(namespace: string, key: string, data: AnyRecord): void {
    const qualified = ClientSettingsFake.#qualify(namespace, key, 'A menu');
    if (!(data.type?.prototype instanceof ApplicationV2)) {
      throw new Error(`Menu ${qualified}: type must extend ApplicationV2`);
    }
    this.menus.set(qualified, { ...data, namespace, key, id: qualified });
  }

  get(namespace: string, key: string): any {
    const [qualified, config] = this.#config(namespace, key);
    return this.values.has(qualified) ? this.values.get(qualified) : config.default;
  }

  /** Store the value; the config's `onChange` runs only when the value differs. */
  async set(namespace: string, key: string, value: unknown): Promise<unknown> {
    const [qualified, config] = this.#config(namespace, key);
    const before = this.get(namespace, key);
    this.values.set(qualified, value);
    if (!Object.is(before, value)) config.onChange?.(value, {});
    return value;
  }
}

// ==== game.i18n ====

export class LocalizationFake {
  lang = 'en';
  readonly translations: AnyRecord;

  constructor(translations: AnyRecord = en) {
    this.translations = translations;
  }

  has(key: string, _fallback = true): boolean {
    return typeof getProperty(this.translations, key) === 'string';
  }

  localize(key: string): string {
    const value = getProperty(this.translations, key);
    return typeof value === 'string' ? value : key;
  }

  format(key: string, data: Record<string, unknown> = {}): string {
    return this.localize(key).replace(/\{(\w+)\}/g, (match, name: string) =>
      name in data ? String(data[name]) : match,
    );
  }
}

// ==== Users ====

/** A Foundry Collection: a Map whose iterator yields values. */
export class Collection<V> extends Map<string, V> {
  override *[Symbol.iterator](): MapIterator<any> {
    yield* this.values();
  }

  get contents(): V[] {
    return [...this.values()];
  }

  find(predicate: (value: V) => boolean): V | undefined {
    return this.contents.find(predicate);
  }

  filter(predicate: (value: V) => boolean): V[] {
    return this.contents.filter(predicate);
  }
}

export interface FakeUserInit {
  id: string;
  name?: string;
  active?: boolean;
  isGM?: boolean;
  canBroadcastAudio?: boolean;
  canBroadcastVideo?: boolean;
}

export class FakeUser {
  readonly id: string;
  name: string;
  active: boolean;
  isGM: boolean;
  permissions: Record<string, boolean>;
  readonly broadcastActivity = vi.fn();

  constructor(init: FakeUserInit) {
    this.id = init.id;
    this.name = init.name ?? init.id;
    this.active = init.active ?? true;
    this.isGM = init.isGM ?? false;
    this.permissions = {
      BROADCAST_AUDIO: init.canBroadcastAudio ?? true,
      BROADCAST_VIDEO: init.canBroadcastVideo ?? true,
    };
  }

  get isSelf(): boolean {
    return globals().game?.user?.id === this.id;
  }

  can(permission: string): boolean {
    return this.isGM || this.permissions[permission] === true;
  }
}

// ==== foundry.av.AVClient ====

/**
 * The members the v14 AVClient page marks "Abstract", with the documented
 * return shape (`async` = returns a Promise). Taken from the API page, not
 * from MediaSoupAVClient.
 */
export const V14_AVCLIENT_ABSTRACT_MEMBERS = {
  connect: 'async',
  disconnect: 'async',
  getConnectedUsers: 'sync',
  getLevelsStreamForUser: 'sync',
  getMediaStreamForUser: 'sync',
  initialize: 'async',
  isAudioEnabled: 'sync',
  isVideoEnabled: 'sync',
  setUserVideo: 'async',
  toggleAudio: 'sync',
  toggleBroadcast: 'sync',
  toggleVideo: 'sync',
  updateLocalStream: 'async',
} as const;

/** The number of parameters the v14 page documents for each abstract member. */
export const V14_AVCLIENT_ARITY: Record<keyof typeof V14_AVCLIENT_ABSTRACT_MEMBERS, number> = {
  connect: 0,
  disconnect: 0,
  getConnectedUsers: 0,
  getLevelsStreamForUser: 1,
  getMediaStreamForUser: 1,
  initialize: 0,
  isAudioEnabled: 0,
  isVideoEnabled: 0,
  setUserVideo: 2,
  toggleAudio: 1,
  toggleBroadcast: 1,
  toggleVideo: 1,
  updateLocalStream: 0,
};

function notImplemented(member: string): Error {
  return new Error(`AVClient#${member} is abstract: the test double has no implementation`);
}

/** foundry.av.AVClient: the documented interface. Abstract members throw. */
export class AVClient {
  master: any;
  settings: any;

  constructor(master: any, settings: any) {
    this.master = master;
    this.settings = settings;
  }

  #voiceModeIs(mode: string): boolean {
    return this.settings?.client?.voice?.mode === mode;
  }

  get isMuted(): boolean {
    return this.settings?.getUser?.(selfId())?.muted === true;
  }

  get isVoiceActivated(): boolean {
    return this.#voiceModeIs(AVSettings.VOICE_MODES.ACTIVITY);
  }

  get isVoiceAlways(): boolean {
    return this.#voiceModeIs(AVSettings.VOICE_MODES.ALWAYS);
  }

  get isVoicePTT(): boolean {
    return this.#voiceModeIs(AVSettings.VOICE_MODES.PTT);
  }

  // The device lists are not abstract; the double offers no devices.
  async getAudioSinks(): Promise<object> {
    return {};
  }

  async getAudioSources(): Promise<object> {
    return {};
  }

  async getVideoSources(): Promise<object> {
    return {};
  }

  onSettingsChanged(_changed: object): void {}

  async connect(): Promise<boolean> {
    throw notImplemented('connect');
  }

  async disconnect(): Promise<boolean> {
    throw notImplemented('disconnect');
  }

  getConnectedUsers(): string[] {
    throw notImplemented('getConnectedUsers');
  }

  getLevelsStreamForUser(_userId: string): MediaStream | null {
    throw notImplemented('getLevelsStreamForUser');
  }

  getMediaStreamForUser(_userId: string): MediaStream | null {
    throw notImplemented('getMediaStreamForUser');
  }

  async initialize(): Promise<void> {
    throw notImplemented('initialize');
  }

  isAudioEnabled(): boolean {
    throw notImplemented('isAudioEnabled');
  }

  isVideoEnabled(): boolean {
    throw notImplemented('isVideoEnabled');
  }

  async setUserVideo(_userId: string, _videoElement: HTMLVideoElement): Promise<void> {
    throw notImplemented('setUserVideo');
  }

  toggleAudio(_enable: boolean): void {
    throw notImplemented('toggleAudio');
  }

  toggleBroadcast(_broadcast: boolean): void {
    throw notImplemented('toggleBroadcast');
  }

  toggleVideo(_enable: boolean): void {
    throw notImplemented('toggleVideo');
  }

  async updateLocalStream(): Promise<void> {
    throw notImplemented('updateLocalStream');
  }
}

/** Stands in for core's default client, the documented AVClient subclass. */
export class SimplePeerAVClient extends AVClient {}

// ==== foundry.av.AVSettings ====

export interface AVClientSettingsInit {
  audioSrc?: string;
  videoSrc?: string;
  audioSink?: string;
  voiceMode?: 'always' | 'activity' | 'ptt';
  muteAll?: boolean;
  users?: Record<string, AnyRecord>;
}

/** The double's voice-activation threshold, in dB (a level at or above it is speech). */
export const VOICE_THRESHOLD_DB = -50;

/** Every AVSettings built, so specs can drop change reports still pending. */
const liveSettings = new Set<AVSettings>();

/** Drop the change reports every AVSettings has not delivered yet. */
export function cancelPendingAVSettings(): void {
  for (const settings of liveSettings) settings.cancelPending();
  liveSettings.clear();
}

/**
 * foundry.av.AVSettings, reduced to what the module reads: `client`, `world`,
 * `get()`, `set()` and `getUser()`. A spec seeds it through the constructor.
 */
export class AVSettings {
  static AV_MODES = { DISABLED: 0, AUDIO: 1, VIDEO: 2, AUDIO_VIDEO: 3 };
  static VOICE_MODES = { ALWAYS: 'always', ACTIVITY: 'activity', PTT: 'ptt' } as const;

  /** The per-user defaults the double fills in (a subset of the documented accessor). */
  static get DEFAULT_USER_SETTINGS(): AnyRecord {
    return { volume: 1, muted: false, hidden: false, blocked: false };
  }

  client: AnyRecord;
  world: AnyRecord;
  /** Changes made through set() and not yet reported. */
  #unreported: AnyRecord | null = null;
  #reportTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(init: AVClientSettingsInit & { mode?: number } = {}) {
    this.world = { mode: init.mode ?? AVSettings.AV_MODES.AUDIO_VIDEO };
    this.client = {
      audioSrc: init.audioSrc ?? 'default',
      videoSrc: init.videoSrc ?? 'default',
      audioSink: init.audioSink ?? 'default',
      muteAll: init.muteAll ?? false,
      voice: { mode: init.voiceMode ?? 'ptt', activityThreshold: VOICE_THRESHOLD_DB },
      users: structuredClone(init.users ?? {}),
    };
    liveSettings.add(this);
  }

  get(scope: 'client' | 'world', path: string): unknown {
    return getProperty(this[scope], path);
  }

  /** The stored per-user values over the defaults, plus the user's permissions. */
  getUser(userId: string): AnyRecord | null {
    const user: FakeUser | undefined = globals().game.users.get(userId);
    if (!user) return null;
    return {
      ...AVSettings.DEFAULT_USER_SETTINGS,
      ...(this.client.users?.[userId] ?? {}),
      canBroadcastAudio: user.can('BROADCAST_AUDIO'),
      canBroadcastVideo: user.can('BROADCAST_VIDEO'),
    };
  }

  /**
   * Apply the value now and report it to `game.webrtc.onSettingsChanged()`
   * on a later task, as a nested object of the paths set since the last
   * report (`set('client', 'voice.mode', 'always')` reports
   * `{ client: { voice: { mode: 'always' } } }`).
   */
  set(scope: 'client' | 'world', path: string, value: unknown): void {
    setProperty(this[scope], path, value);
    const change: AnyRecord = {};
    setProperty(change, `${scope}.${path}`, value);
    this.#unreported = mergeObject(this.#unreported ?? {}, change);
    this.#reportTimer ??= setTimeout(() => this.#report(), 0);
  }

  #report(): void {
    const change = this.#unreported;
    this.cancelPending();
    if (change) globals().game.webrtc?.onSettingsChanged(change);
  }

  cancelPending(): void {
    clearTimeout(this.#reportTimer);
    this.#reportTimer = undefined;
    this.#unreported = null;
  }
}

// ==== foundry.av.AVMaster ====

export interface AVMasterOptions {
  /**
   * Build a master without `render()`, to check the client's fallback to
   * `ui.webrtc`. (14.368 does define `AVMaster#render`; it is not on the API page.)
   */
  omitRender?: boolean;
}

/** How often the double asks for level reports (ms); any value works. */
const LEVEL_REPORT_MS = 50;

/**
 * foundry.av.AVMaster, reduced to the members the module calls or that drive
 * it. Takes its AVSettings so a spec can seed them, and builds its client
 * with `new CONFIG.WebRTC.clientClass(master, settings)`.
 */
export class AVMaster {
  settings: AVSettings;
  client: any;
  broadcasting = false;
  render?: Mock<(...args: any[]) => unknown>;
  #live = false;

  /**
   * Set the broadcast state: on only when asked for and the user may share
   * audio. Passes it to `client.toggleBroadcast` and the speaking indicator.
   */
  readonly broadcast = vi.fn((intent: boolean) => {
    const on = intent === true && this.canUserShareAudio(selfId());
    this.broadcasting = on;
    this.client.toggleBroadcast(on);
    globals().ui.webrtc?.setUserIsSpeaking(selfId(), on);
  });

  /**
   * Voice-detection stand-in: clears the speaking indicator and stops level
   * reports; in "activity" mode it then listens on the client's levels stream
   * and broadcasts while the level is at or above the threshold.
   */
  readonly _initializeUserVoiceDetection = vi.fn((mode: string) => {
    const { audio } = globals().game;
    audio.stopLevelReports(selfId());
    globals().ui.webrtc?.setUserIsSpeaking(selfId(), false);
    if (mode !== AVSettings.VOICE_MODES.ACTIVITY) return;
    const levels = this.client.getLevelsStreamForUser(selfId());
    if (!levels) return;
    audio.startLevelReports(selfId(), levels, (db: number) => this.#onLevel(db), LEVEL_REPORT_MS);
  });

  /** A spy only: the module recovers by itself and must never call it. */
  readonly reestablish = vi.fn(async () => {});

  /** Hands the change to the client (the module's handler under test). */
  readonly onSettingsChanged = vi.fn((changed: object): Promise<boolean> | undefined => {
    this.client.onSettingsChanged(changed);
    return undefined;
  });

  constructor(settings: AVSettings = new AVSettings(), options: AVMasterOptions = {}) {
    this.settings = settings;
    if (!options.omitRender) this.render = vi.fn(() => globals().ui.webrtc.render());
    const { clientClass } = (globalThis as any).CONFIG.WebRTC;
    this.client = new clientClass(this, settings);
  }

  /** Disconnect, then initialize and connect the client unless A/V is disabled. */
  async connect(): Promise<boolean> {
    const enabled = this.#modeIncludes('audio') || this.#modeIncludes('video');
    await this.disconnect();
    if (!enabled) return false;
    await this.client.initialize();
    if (!(await this.client.connect())) return false;
    this.#live = true;
    this.#afterConnect();
    return true;
  }

  async disconnect(): Promise<boolean> {
    const wasLive = this.#live;
    this.#live = false;
    if (wasLive) await this.client.disconnect();
    return wasLive;
  }

  /** Once connected: voice detection for the mode, the sharing state, a render. */
  #afterConnect(): void {
    const mode = this.settings.client.voice.mode;
    const alwaysOn = mode === AVSettings.VOICE_MODES.ALWAYS;
    this._initializeUserVoiceDetection(mode);
    this.client.toggleAudio(alwaysOn && this.canUserShareAudio(selfId()));
    this.client.toggleVideo(this.canUserShareVideo(selfId()));
    this.broadcast(alwaysOn);
    globals().ui.webrtc.render();
  }

  #onLevel(db: number): void {
    const { voice } = this.settings.client;
    if (voice.mode !== AVSettings.VOICE_MODES.ACTIVITY) return;
    const speech = db >= voice.activityThreshold;
    if (speech !== this.broadcasting) this.broadcast(speech);
  }

  /** Does the world A/V mode include this kind of media? */
  #modeIncludes(kind: 'audio' | 'video'): boolean {
    const { AUDIO, VIDEO, AUDIO_VIDEO } = AVSettings.AV_MODES;
    const mode = this.settings.world.mode;
    return mode === AUDIO_VIDEO || mode === (kind === 'audio' ? AUDIO : VIDEO);
  }

  canUserBroadcastAudio(userId: string): boolean {
    return this.#modeIncludes('audio') && this.settings.getUser(userId)?.canBroadcastAudio === true;
  }

  canUserBroadcastVideo(userId: string): boolean {
    return this.#modeIncludes('video') && this.settings.getUser(userId)?.canBroadcastVideo === true;
  }

  /** Allowed to broadcast, and neither self-muted nor blocked. */
  canUserShareAudio(userId: string): boolean {
    const stored = this.settings.getUser(userId);
    return this.canUserBroadcastAudio(userId) && !stored?.muted && !stored?.blocked;
  }

  /** Allowed to broadcast, and neither self-hidden nor blocked. */
  canUserShareVideo(userId: string): boolean {
    const stored = this.settings.getUser(userId);
    return this.canUserBroadcastVideo(userId) && !stored?.hidden && !stored?.blocked;
  }
}

// ==== foundry.applications.api ====

let appCounter = 0;

/** The ApplicationV2 subclasses from ApplicationV2 itself down to `cls`. */
function appLineage(cls: any): Array<typeof ApplicationV2> {
  const lineage: Array<typeof ApplicationV2> = [];
  for (let c = cls; c; c = c === ApplicationV2 ? null : Reflect.getPrototypeOf(c)) {
    lineage.push(c);
  }
  return lineage.reverse();
}

/**
 * foundry.applications.api.ApplicationV2, reduced to merged options, a
 * context, render hooks with an HTMLElement, close, and a form submit.
 */
export class ApplicationV2 {
  /** The double's own base options: only what render(), title and submit() read. */
  static DEFAULT_OPTIONS: AnyRecord = {
    id: 'app-{id}',
    tag: 'div',
    classes: [],
    window: { title: '', minimizable: true },
  };

  readonly options: AnyRecord;
  element: HTMLElement | null = null;
  rendered = false;
  closed = false;

  constructor(options: AnyRecord = {}) {
    // Each class's own DEFAULT_OPTIONS, base first, then the caller's options.
    const layers = appLineage(this.constructor)
      .filter((cls) => Object.hasOwn(cls, 'DEFAULT_OPTIONS'))
      .map((cls) => cls.DEFAULT_OPTIONS);
    const merged = [...layers, options].reduce((acc, layer) => mergeObject(acc, layer), {});
    merged.id = String(merged.id).replace('{id}', String(++appCounter));
    this.options = merged;
  }

  get id(): string {
    return this.options.id;
  }

  get title(): string {
    return globals().game.i18n.localize(this.options.window.title);
  }

  async _prepareContext(_options: unknown): Promise<AnyRecord> {
    return {};
  }

  /** Build the element and fire `render<ClassName>` for each class in the lineage. */
  async render(renderOptions: AnyRecord = {}): Promise<this> {
    const data = await this._prepareContext(renderOptions);
    const root = document.createElement(this.options.tag);
    root.id = this.id;
    root.classList.add('application', ...(this.options.classes ?? []));
    this.element = root;
    this.rendered = true;
    for (const cls of appLineage(this.constructor)) {
      globals().Hooks.callAll(`render${cls.name}`, this, root, data, renderOptions);
    }
    return this;
  }

  async close(): Promise<this> {
    this.rendered = false;
    this.closed = true;
    return this;
  }

  /**
   * Test helper: run `options.form.handler` with `this` bound to the app and
   * `{ object }` standing in for FormDataExtended, then close if configured.
   */
  async submit(object: AnyRecord): Promise<void> {
    const { handler, closeOnSubmit } = this.options.form ?? {};
    if (typeof handler !== 'function') throw new Error(`${this.id} has no form handler`);
    await handler.call(this, new Event('submit'), document.createElement('form'), { object });
    if (closeOnSubmit) await this.close();
  }
}

/** foundry.applications.api.HandlebarsApplicationMixin: adds `PARTS`, marks the class. */
export function HandlebarsApplicationMixin<T extends typeof ApplicationV2>(BaseApplication: T): T {
  class HandlebarsApplication extends (BaseApplication as typeof ApplicationV2) {
    static PARTS: AnyRecord = {};
    static readonly HANDLEBARS_MIXIN = true;
  }
  return HandlebarsApplication as unknown as T;
}

// ==== ui ====

export function createNotifications() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    notify: vi.fn(),
  };
}

/**
 * ui.webrtc (CameraViews), reduced to its tiles: `videos` holds the `<video>`
 * per user a spec put in the dock, and render() passes each one to
 * `game.webrtc.client.setUserVideo()`.
 */
export class CameraViewsFake {
  readonly videos = new Map<string, HTMLVideoElement>();
  /** userId -> the last speaking state set. */
  readonly speaking = new Map<string, boolean>();

  readonly render = vi.fn(async (_options?: unknown) => {
    const client = globals().game?.webrtc?.client;
    if (!client) return this;
    for (const [userId, video] of this.videos) {
      await client.setUserVideo(userId, video);
    }
    return this;
  });

  readonly setUserIsSpeaking = vi.fn((userId: string, speaking: boolean) => {
    this.speaking.set(userId, speaking);
  });

  getUserVideoElement(userId: string): HTMLVideoElement | null {
    return this.videos.get(userId) ?? null;
  }
}

/** game.audio, reduced to level reports: recorded, handlers kept. */
export function createAudioHelper() {
  const levelHandlers = new Map<string, (dbLevel: number) => unknown>();
  return {
    levelHandlers,
    startLevelReports: vi.fn(
      (id: string, _stream: MediaStream, callback: (dbLevel: number) => unknown, _ms?: number) => {
        levelHandlers.set(id, callback);
      },
    ),
    stopLevelReports: vi.fn((id: string) => {
      levelHandlers.delete(id);
    }),
  };
}

// ==== Install ====

export interface FoundryV14Env {
  hooks: HooksRegistry;
  settings: ClientSettingsFake;
  i18n: LocalizationFake;
  users: Collection<FakeUser>;
  notifications: ReturnType<typeof createNotifications>;
  cameraViews: CameraViewsFake;
  audio: ReturnType<typeof createAudioHelper>;
  game: AnyRecord;
  ui: AnyRecord;
  CONFIG: AnyRecord;
  foundry: AnyRecord;
}

export interface InstallOptions {
  userId?: string;
  users?: FakeUserInit[];
  worldId?: string;
}

export const LOCAL_USER_ID = 'userA';
export const REMOTE_USER_ID = 'userB';
export const WORLD_ID = 'world-fixture';

/** Install the v14 globals (`game`, `ui`, `Hooks`, `CONFIG`, `foundry`). */
export function installFoundryV14(options: InstallOptions = {}): FoundryV14Env {
  const userId = options.userId ?? LOCAL_USER_ID;
  const users = new Collection<FakeUser>();
  for (const init of options.users ?? [
    { id: LOCAL_USER_ID, name: 'Alice', isGM: true },
    { id: REMOTE_USER_ID, name: 'Bob' },
  ]) {
    users.set(init.id, new FakeUser(init));
  }

  const hooks = new HooksRegistry();
  const settings = new ClientSettingsFake();
  const i18n = new LocalizationFake();
  const notifications = createNotifications();
  const cameraViews = new CameraViewsFake();
  const audio = createAudioHelper();

  const game: AnyRecord = {
    audio,
    settings,
    i18n,
    users,
    user: users.get(userId),
    userId,
    world: { id: options.worldId ?? WORLD_ID, title: 'Fixture World' },
    modules: new Map([['mediasoup-vtt', { id: 'mediasoup-vtt', active: true }]]),
    release: { generation: 14, build: 368 },
    webrtc: undefined,
  };
  const ui: AnyRecord = { notifications, webrtc: cameraViews };
  const CONFIG: AnyRecord = { WebRTC: { clientClass: SimplePeerAVClient } };
  const foundry: AnyRecord = {
    av: { AVClient, AVMaster, AVSettings, clients: { SimplePeerAVClient } },
    applications: { api: { ApplicationV2, HandlebarsApplicationMixin } },
    utils: { getProperty, setProperty, mergeObject },
  };

  const g = globalThis as any;
  g.game = game;
  g.ui = ui;
  g.Hooks = hooks;
  g.CONFIG = CONFIG;
  g.foundry = foundry;

  return {
    hooks,
    settings,
    i18n,
    users,
    notifications,
    cameraViews,
    audio,
    game,
    ui,
    CONFIG,
    foundry,
  };
}

/** The installed environment (set up by tests/setup.ts). */
export function foundryEnv(): FoundryV14Env {
  const g = globalThis as any;
  return {
    hooks: g.Hooks,
    settings: g.game.settings,
    i18n: g.game.i18n,
    users: g.game.users,
    notifications: g.ui.notifications,
    cameraViews: g.ui.webrtc,
    audio: g.game.audio,
    game: g.game,
    ui: g.ui,
    CONFIG: g.CONFIG,
    foundry: g.foundry,
  };
}

/** Register the module's settings the way `registerSettings()` would have, for AV tests. */
export function seedModuleSettings(values: {
  serverUrl?: string;
  authToken?: string;
  debugLogging?: boolean;
}): void {
  const settings = globals().game.settings as ClientSettingsFake;
  const entries: Array<[string, unknown, string]> = [
    ['mediaSoupServerUrl', values.serverUrl ?? '', 'world'],
    ['mediaSoupAuthToken', values.authToken ?? '', 'world'],
    ['debugLogging', values.debugLogging ?? false, 'client'],
  ];
  for (const [key, value, scope] of entries) {
    if (!settings.settings.has(`mediasoup-vtt.${key}`)) {
      settings.register('mediasoup-vtt', key, { scope, config: true, default: '' });
    }
    settings.values.set(`mediasoup-vtt.${key}`, value);
  }
}
