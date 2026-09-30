/**
 * Settings registration and the Settings-page enhancements for MediaSoupVTT.
 *
 * Only the server connection and debug settings live here. Devices, mute state
 * and push-to-talk belong to core AVSettings (Configure Audio/Video), because
 * MediaSoupVTT is a Foundry AVClient registered as `CONFIG.WebRTC.clientClass`.
 */

import { MediaSoupAVClient } from '../client/MediaSoupAVClient.js';
import {
  MODULE_ID,
  SETTING_DEBUG_LOGGING,
  SETTING_MEDIASOUP_AUTH_TOKEN,
  SETTING_MEDIASOUP_URL,
} from '../constants/index.js';
import { log } from '../utils/logger.js';
import { MediaSoupConfigDialog } from './configDialog.js';
import { SETTINGS_HELP_CLASS, STATUS_INDICATOR_CLASS } from './styles.js';

/** Key of the settings menu that opens the configuration dialog. */
export const CONFIG_MENU_KEY = 'configDialog';

export { SETTINGS_HELP_CLASS, STATUS_INDICATOR_CLASS };

/** Delay before reconnecting after a connection setting changes. */
const RECONNECT_DEBOUNCE_MS = 500;

/** `AVSettings.AV_MODES.DISABLED` (v13 and v14). */
const AV_MODE_DISABLED = 0;

/** The world half of AVSettings: only the conference mode is read here. */
interface AVWorldSettingsLike {
  world?: { mode?: number };
}

/** The subset of AVMaster (`game.webrtc`) and its AVClient this file touches. */
interface AVMasterLike {
  client?: {
    isConnected?: unknown;
    settings?: AVWorldSettingsLike;
  } | null;
  settings?: AVWorldSettingsLike;
  connect?: () => Promise<boolean>;
}

function localize(key: string): string {
  return game.i18n?.localize(key) ?? key;
}

function getAVMaster(): AVMasterLike | undefined {
  return (game as { webrtc?: AVMasterLike }).webrtc;
}

/**
 * True when core A/V is using this module's AVClient. An `instanceof` check,
 * not the class name: a minifier may rename the class, and another module's
 * client could share the name. (MediaSoupAVClient does not import this file,
 * so there is no import cycle.)
 */
function isMediaSoupClientActive(webrtc: AVMasterLike | undefined): boolean {
  return webrtc?.client instanceof MediaSoupAVClient;
}

/**
 * The configured A/V conference mode, or undefined if it cannot be read.
 * AVClient#settings is public API; AVMaster#settings is a fallback.
 */
function getAVMode(webrtc: AVMasterLike | undefined): number | undefined {
  const mode = webrtc?.client?.settings?.world?.mode ?? webrtc?.settings?.world?.mode;
  return typeof mode === 'number' ? mode : undefined;
}

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Reconnect the A/V session after the server URL or token changes. World
 * settings fire `onChange` on every connected client, so every peer moves to
 * the new server together. AVMaster.connect() disconnects the client first.
 */
function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    const webrtc = getAVMaster();
    if (!isMediaSoupClientActive(webrtc) || !webrtc?.connect) return;
    if (getAVMode(webrtc) === AV_MODE_DISABLED) return;
    ui.notifications?.info(localize('MEDIASOUPVTT.Notifications.Reconnecting'));
    webrtc.connect().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`Reconnect after settings change failed: ${message}`, 'error');
    });
  }, RECONNECT_DEBOUNCE_MS);
}

/**
 * Register the module settings, the configuration menu and the Settings-page
 * hook. Call once from the `init` hook.
 */
export function registerSettings(): void {
  game.settings.register(MODULE_ID, SETTING_DEBUG_LOGGING, {
    name: 'MEDIASOUPVTT.Settings.DebugLogging.Name',
    hint: 'MEDIASOUPVTT.Settings.DebugLogging.Hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTING_MEDIASOUP_URL, {
    name: 'MEDIASOUPVTT.Settings.ServerUrl.Name',
    hint: 'MEDIASOUPVTT.Settings.ServerUrl.Hint',
    scope: 'world',
    config: true,
    type: String,
    default: '',
    onChange: (value: string) => {
      log(`MediaSoup server URL changed to: ${value}`);
      scheduleReconnect();
    },
  });

  game.settings.register(MODULE_ID, SETTING_MEDIASOUP_AUTH_TOKEN, {
    name: 'MEDIASOUPVTT.Settings.AuthToken.Name',
    hint: 'MEDIASOUPVTT.Settings.AuthToken.Hint',
    scope: 'world',
    config: true,
    type: String,
    default: '',
    onChange: (value: string) => {
      log(`MediaSoup auth token changed (length: ${value ? value.length : 0})`);
      scheduleReconnect();
    },
  });

  game.settings.registerMenu(MODULE_ID, CONFIG_MENU_KEY, {
    name: 'MEDIASOUPVTT.Menu.Name',
    label: 'MEDIASOUPVTT.Menu.Label',
    hint: 'MEDIASOUPVTT.Menu.Hint',
    icon: 'fa-solid fa-server',
    type: MediaSoupConfigDialog,
    restricted: true,
  });

  setupSettingsHooks();
}

let settingsHookId: number | undefined;

/**
 * Install the `renderSettingsConfig` hook. Idempotent: `registerSettings()`
 * already calls it, and calling it again does not add a second handler.
 */
export function setupSettingsHooks(): void {
  if (settingsHookId !== undefined) return;
  settingsHookId = Hooks.on('renderSettingsConfig', onRenderSettingsConfig);
}

/**
 * `renderSettingsConfig` handler. SettingsConfig is an ApplicationV2
 * (CategoryBrowser) in v13 and v14, so the hook passes an HTMLElement. The
 * handler never re-renders the app, and calling it again on the same element
 * updates the injected block instead of adding a second one.
 */
export function onRenderSettingsConfig(_app: unknown, element: unknown): void {
  if (!(element instanceof HTMLElement)) return;
  try {
    const section = findModuleSection(element);
    if (!section) return;
    injectSettingsHelp(section);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed to enhance the Settings page: ${message}`, 'warn');
  }
}

/**
 * Find the container holding this module's settings.
 *
 * The CategoryBrowser renders one section per category, keyed by the module
 * id as `data-tab` (tab panel) and/or `data-category`; the sidebar nav uses the
 * same `data-tab` on its buttons, so buttons and links are excluded. As a
 * fallback, walk up from one of this module's setting inputs, which Foundry
 * names `<namespace>.<key>`.
 */
export function findModuleSection(root: HTMLElement): HTMLElement | null {
  const direct = root.querySelector<HTMLElement>(
    [
      `section[data-tab="${MODULE_ID}"]`,
      `section[data-category="${MODULE_ID}"]`,
      `.tab[data-tab="${MODULE_ID}"]:not(button):not(a)`,
      `[data-category="${MODULE_ID}"]:not(button):not(a)`,
    ].join(', '),
  );
  if (direct) return direct;

  const field = root.querySelector<HTMLElement>(
    `[name^="${MODULE_ID}."], [data-setting-id^="${MODULE_ID}."], [data-key^="${MODULE_ID}."]`,
  );
  if (!field) return null;
  return (
    field.closest<HTMLElement>('[data-tab], [data-category], section, fieldset') ??
    field.closest<HTMLElement>('.form-group')?.parentElement ??
    null
  );
}

function injectSettingsHelp(section: HTMLElement): void {
  let help = section.querySelector<HTMLElement>(`:scope > .${SETTINGS_HELP_CLASS}`);
  if (!help) {
    help = buildHelpBox();
    section.append(help);
  }
  updateStatusIndicator(help);
}

function buildHelpBox(): HTMLElement {
  const help = document.createElement('div');
  help.className = SETTINGS_HELP_CLASS;

  const heading = document.createElement('h4');
  const icon = document.createElement('i');
  icon.className = 'fa-solid fa-circle-info';
  icon.setAttribute('inert', '');
  heading.append(icon, ` ${localize('MEDIASOUPVTT.SettingsHelp.Title')} `);
  const status = document.createElement('span');
  status.className = STATUS_INDICATOR_CLASS;
  heading.append(status);

  const steps = document.createElement('ol');
  for (const key of ['Step1', 'Step2', 'Step3']) {
    const item = document.createElement('li');
    item.textContent = localize(`MEDIASOUPVTT.SettingsHelp.${key}`);
    steps.append(item);
  }

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = localize('MEDIASOUPVTT.SettingsHelp.Note');

  help.append(heading, steps, note);
  return help;
}

function updateStatusIndicator(help: HTMLElement): void {
  const status = help.querySelector<HTMLElement>(`.${STATUS_INDICATOR_CLASS}`);
  if (!status) return;

  const webrtc = getAVMaster();
  let state: 'connected' | 'active' | 'inactive';
  if (!isMediaSoupClientActive(webrtc) || getAVMode(webrtc) === AV_MODE_DISABLED) {
    state = 'inactive';
  } else if (webrtc?.client?.isConnected === true) state = 'connected';
  else state = 'active';

  const labels = {
    connected: 'MEDIASOUPVTT.Status.Connected',
    active: 'MEDIASOUPVTT.Status.Active',
    inactive: 'MEDIASOUPVTT.Status.Inactive',
  } as const;
  status.dataset.state = state;
  status.textContent = localize(labels[state]);
}
