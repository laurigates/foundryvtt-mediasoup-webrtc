// Loose ambient types for the Foundry VTT client globals this module touches.
// These are intentionally permissive (`any`-heavy) — just enough to keep `tsc`
// green. Verify the real Foundry API before trusting any shape here:
// https://foundryvtt.com/api/  (or the live browser console). See CLAUDE.md.
//
// The A/V shapes below follow the v14 API pages for foundry.av.AVClient,
// foundry.av.AVMaster and foundry.av.AVSettings (14.368). They are identical
// in v13 for every member declared here.

// biome-ignore-all lint: ambient declarations, not runtime code.

/* -------------------------------------------- */
/*  Audio/Video (foundry.av.*)                  */
/* -------------------------------------------- */

/** AVSettings.VOICE_MODES values. */
type FoundryVoiceMode = 'always' | 'activity' | 'ptt';

interface FoundryAVStoredUserSettings {
  popout: boolean;
  x: number;
  y: number;
  z: number;
  width: number;
  volume: number;
  muted: boolean;
  hidden: boolean;
  blocked: boolean;
  [key: string]: unknown;
}

interface FoundryAVUserSettings extends FoundryAVStoredUserSettings {
  canBroadcastAudio: boolean;
  canBroadcastVideo: boolean;
}

interface FoundryAVClientSettings {
  videoSrc: string;
  audioSrc: string;
  audioSink: string;
  dockPosition: string;
  hidePlayerList: boolean;
  hideDock: boolean;
  muteAll: boolean;
  disableVideo: boolean;
  borderColors: boolean;
  dockWidth: number;
  nameplates: number;
  voice: {
    mode: FoundryVoiceMode;
    pttName: string;
    pttDelay: number;
    activityThreshold: number;
  };
  users: Record<string, FoundryAVStoredUserSettings>;
  [key: string]: unknown;
}

interface FoundryAVWorldSettings {
  mode: number;
  turn: { type: string; url: string; username: string; password: string };
  [key: string]: unknown;
}

/** foundry.av.AVSettings instance (`game.webrtc.settings`). */
interface FoundryAVSettings {
  client: FoundryAVClientSettings;
  world: FoundryAVWorldSettings;
  activity: Record<string, { muted?: boolean; hidden?: boolean; speaking?: boolean }>;
  get(scope: 'client' | 'world', setting: string): unknown;
  set(scope: 'client' | 'world', setting: string, value: unknown): void;
  getUser(userId: string): FoundryAVUserSettings | null;
  readonly users: Record<string, FoundryAVUserSettings>;
  readonly verticalDock: boolean;
  handleUserActivity(userId: string, settings: Record<string, unknown>): void;
}

/** Static side of foundry.av.AVSettings. */
interface FoundryAVSettingsClass {
  new (): FoundryAVSettings;
  AV_MODES: { DISABLED: number; AUDIO: number; VIDEO: number; AUDIO_VIDEO: number };
  VOICE_MODES: { ALWAYS: 'always'; ACTIVITY: 'activity'; PTT: 'ptt' };
  NAMEPLATE_MODES: Record<string, number>;
  DOCK_POSITIONS: Record<string, string>;
}

/** foundry.av.AVMaster instance (`game.webrtc`). */
interface FoundryAVMaster {
  settings: FoundryAVSettings;
  client: FoundryAVClient;
  config?: any;
  broadcasting: boolean;
  /** AVSettings.AV_MODES value of the world. */
  readonly mode: number;
  connect(): Promise<boolean>;
  disconnect(): Promise<boolean>;
  reestablish(): Promise<void>;
  canUserBroadcastAudio(userId: string): boolean;
  canUserBroadcastVideo(userId: string): boolean;
  canUserShareAudio(userId: string): boolean;
  canUserShareVideo(userId: string): boolean;
  broadcast(intent: boolean): any;
  activateVoiceDetection(stream: MediaStream, ms?: number): void;
  deactivateVoiceDetection(): void;
  /** @internal Re-reads the levels stream; SimplePeer calls it after swapping streams. */
  _initializeUserVoiceDetection?(mode: string): void;
  /** Re-render the camera views. Present on v13; not listed on the v14 API page. */
  render?(): unknown;
  onSettingsChanged(changed: object): Promise<boolean> | undefined | void;
}

/**
 * foundry.av.AVClient — the abstract A/V client that CONFIG.WebRTC.clientClass
 * must extend. Abstract members match the v14 signatures (sync vs async).
 */
declare abstract class FoundryAVClient {
  constructor(master: FoundryAVMaster, settings: FoundryAVSettings);
  master: FoundryAVMaster;
  settings: FoundryAVSettings;
  get isMuted(): boolean;
  get isVoiceActivated(): boolean;
  get isVoiceAlways(): boolean;
  get isVoicePTT(): boolean;
  abstract initialize(): Promise<void>;
  abstract connect(): Promise<boolean>;
  abstract disconnect(): Promise<boolean>;
  getAudioSinks(): Promise<object>;
  getAudioSources(): Promise<object>;
  getVideoSources(): Promise<object>;
  abstract getConnectedUsers(): string[];
  abstract getMediaStreamForUser(userId: string): MediaStream | null;
  abstract getLevelsStreamForUser(userId: string): MediaStream | null;
  abstract isAudioEnabled(): boolean;
  abstract isVideoEnabled(): boolean;
  abstract toggleAudio(enable: boolean): void;
  abstract toggleBroadcast(broadcast: boolean): void;
  abstract toggleVideo(enable: boolean): void;
  abstract setUserVideo(userId: string, videoElement: HTMLVideoElement): Promise<void>;
  onSettingsChanged(changed: object): void;
  abstract updateLocalStream(): Promise<void>;
}

interface FoundryAVNamespace {
  AVClient: typeof FoundryAVClient;
  AVMaster: new () => FoundryAVMaster;
  AVSettings: FoundryAVSettingsClass;
  clients?: Record<string, any>;
  [key: string]: any;
}

/* -------------------------------------------- */
/*  Scene controls and render hooks             */
/* -------------------------------------------- */

/** A tool inside a scene control (v13+: a Record keyed by tool name). */
interface FoundrySceneControlTool {
  name: string;
  title: string;
  icon: string;
  order?: number;
  button?: boolean;
  toggle?: boolean;
  active?: boolean;
  visible?: boolean;
  onChange?: (event: Event, active: boolean) => void;
  [key: string]: unknown;
}

/** A scene control group (v13+). The scene-controls hook receives a Record of these. */
interface FoundrySceneControl {
  name: string;
  title: string;
  icon: string;
  order?: number;
  visible?: boolean;
  activeTool?: string;
  tools: Record<string, FoundrySceneControlTool>;
  onChange?: (event: Event, active: boolean) => void;
  onToolChange?: (event: Event, tool: FoundrySceneControlTool) => void;
  [key: string]: unknown;
}

/**
 * Handler shape for the v13+ scene-controls hook: `controls` is a Record keyed
 * by control name (it was an Array before v13).
 */
type FoundrySceneControlsHook = (controls: Record<string, FoundrySceneControl>) => unknown;

/** `renderApplicationV2` / `render<AppName>` hook handler (element is an HTMLElement, not jQuery). */
type FoundryRenderApplicationV2Hook = (
  application: any,
  element: HTMLElement,
  context: Record<string, any>,
  options: Record<string, any>,
) => unknown;

/* -------------------------------------------- */
/*  Game, UI, Hooks                             */
/* -------------------------------------------- */

interface FoundrySettings {
  register(namespace: string, key: string, data: Record<string, unknown>): void;
  registerMenu(namespace: string, key: string, data: Record<string, unknown>): void;
  get(namespace: string, key: string): any;
  set(namespace: string, key: string, value: unknown): Promise<unknown>;
  // The registered-settings registry: `game.settings.settings.get("<ns>.<key>")`
  // returns the setting config object.
  settings: Map<string, any>;
  sheet?: any;
}

interface FoundryGame {
  settings: FoundrySettings;
  modules: Map<string, any> & { get(id: string): any };
  user?: any;
  userId?: string;
  users?: any;
  world?: any;
  /** The AVMaster singleton; created by Game#initializeRTC during setupGame. */
  webrtc?: FoundryAVMaster;
  i18n?: {
    lang?: string;
    has?(key: string, fallback?: boolean): boolean;
    localize(key: string): string;
    format(key: string, data?: Record<string, unknown>): string;
  };
  [key: string]: any;
}

interface FoundryNotifications {
  info(message: string, options?: Record<string, unknown>): void;
  warn(message: string, options?: Record<string, unknown>): void;
  error(message: string, options?: Record<string, unknown>): void;
  notify(message: string, type?: string, options?: Record<string, unknown>): void;
}

interface FoundryUI {
  notifications: FoundryNotifications;
  players?: any;
  controls?: any;
  /** CameraViews (AppV2). */
  webrtc?: any;
  [key: string]: any;
}

type FoundryHookFn = (...args: any[]) => any;

interface FoundryHooks {
  on(hook: `render${string}`, fn: FoundryRenderApplicationV2Hook): number;
  on(hook: string, fn: FoundryHookFn): number;
  once(hook: `render${string}`, fn: FoundryRenderApplicationV2Hook): number;
  once(hook: string, fn: FoundryHookFn): number;
  off(hook: string, fn: number | FoundryHookFn): void;
  call(hook: string, ...args: any[]): boolean;
  callAll(hook: string, ...args: any[]): boolean;
}

interface FoundryWebRTCConfig {
  /** The AVClient subclass AVMaster instantiates. */
  clientClass: new (
    master: FoundryAVMaster,
    settings: FoundryAVSettings,
  ) => FoundryAVClient;
  debugPrefix?: string;
  [key: string]: any;
}

declare global {
  const game: FoundryGame;
  const ui: FoundryUI;
  const Hooks: FoundryHooks;
  const CONFIG: { WebRTC: FoundryWebRTCConfig; [key: string]: any };
  // Foundry application base classes (v1 + v2 namespaces). Loose on purpose.
  const FormApplication: any;
  const Application: any;
  const Dialog: any;
  const foundry: { av: FoundryAVNamespace; [key: string]: any };

  type AVClient = FoundryAVClient;
  type AVMaster = FoundryAVMaster;
  type AVSettings = FoundryAVSettings;
  type AVClientSettings = FoundryAVClientSettings;
  type SceneControl = FoundrySceneControl;
  type SceneControlTool = FoundrySceneControlTool;
  type SceneControlsHook = FoundrySceneControlsHook;
  type RenderApplicationV2Hook = FoundryRenderApplicationV2Hook;

  interface Window {
    mediasoupClient?: any;
    MediaSoupVTT_Client?: any;
  }
}

export {};
