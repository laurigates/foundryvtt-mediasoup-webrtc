/**
 * Settings registration and the Settings-page (SettingsConfig, AppV2) hook,
 * against the v14 ClientSettings and Hooks fakes.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MediaSoupAVClient } from '../../../src/client/MediaSoupAVClient';
import { MediaSoupConfigDialog } from '../../../src/ui/configDialog';
import {
  CONFIG_MENU_KEY,
  findModuleSection,
  onRenderSettingsConfig,
  registerSettings,
  SETTINGS_HELP_CLASS,
  STATUS_INDICATOR_CLASS,
  setupSettingsHooks,
} from '../../../src/ui/settings';
import {
  ApplicationV2,
  AVMaster,
  AVSettings,
  foundryEnv,
  getProperty,
  SimplePeerAVClient,
} from '../helpers/foundry-v14';

const env = foundryEnv();
const en = env.i18n.translations;

beforeAll(() => {
  // What the module entry does at import time.
  env.CONFIG.WebRTC.clientClass = MediaSoupAVClient;
  registerSettings();
});

afterEach(() => {
  env.game.webrtc = undefined;
  vi.useRealTimers();
});

/**
 * A v14 SettingsConfig (CategoryBrowser) element with this module's category.
 *
 * These are hand-written approximations, not Foundry's markup. The 'core-cb'
 * variant models a category-browser layout: each entry is a `.form-group`
 * inside a `[data-category]` element, and the sidebar has a
 * `button[data-tab="<category>"]` with a `span[data-count]`. Only the
 * Foundry e2e tier (tests/e2e/foundry) checks the real page.
 */
function settingsPage(
  variant: 'section' | 'div-tab' | 'input-only' | 'core-cb' = 'section',
): HTMLElement {
  const root = document.createElement('div');
  root.id = 'settings-config';
  const fields = `
    <div class="form-group">
      <label>MediaSoup Server WebSocket URL</label>
      <div class="form-fields"><input type="url" name="mediasoup-vtt.mediaSoupServerUrl"></div>
    </div>`;
  const nav = `<nav class="tabs"><button type="button" class="tab" data-tab="core">Core</button>
    <button type="button" class="tab" data-tab="mediasoup-vtt" data-category="mediasoup-vtt">MediaSoupVTT</button></nav>`;
  if (variant === 'section') {
    root.innerHTML = `${nav}<section class="tab" data-tab="core"></section>
      <section class="tab active" data-tab="mediasoup-vtt" data-group="categories">${fields}</section>`;
  } else if (variant === 'div-tab') {
    root.innerHTML = `${nav}<div class="tab" data-tab="mediasoup-vtt">${fields}</div>`;
  } else if (variant === 'core-cb') {
    root.innerHTML = `<nav><button type="button" data-tab="core">Core<span data-count>1</span></button>
      <button type="button" data-tab="mediasoup-vtt">MediaSoupVTT<span data-count>3</span></button></nav>
      <div data-category="core"><div class="form-group"><input name="core.language"></div></div>
      <div data-category="mediasoup-vtt">${fields}</div>`;
  } else {
    root.innerHTML = `<div class="category"><fieldset>${fields}</fieldset></div>`;
  }
  return root;
}

function statusOf(root: HTMLElement): { state?: string; text?: string | null } {
  const status = root.querySelector<HTMLElement>(`.${STATUS_INDICATOR_CLASS}`);
  return { state: status?.dataset.state, text: status?.textContent };
}

describe('registerSettings', () => {
  it('registers exactly the three module settings', () => {
    const ids = [...env.settings.settings.keys()].filter((k) => k.startsWith('mediasoup-vtt.'));
    expect(ids.sort()).toEqual([
      'mediasoup-vtt.debugLogging',
      'mediasoup-vtt.mediaSoupAuthToken',
      'mediasoup-vtt.mediaSoupServerUrl',
    ]);
  });

  it('gives each setting its scope, type, default and a localized name that exists in lang/en.json', () => {
    const expected = {
      'mediasoup-vtt.debugLogging': { scope: 'client', type: Boolean, default: false },
      'mediasoup-vtt.mediaSoupServerUrl': { scope: 'world', type: String, default: '' },
      'mediasoup-vtt.mediaSoupAuthToken': { scope: 'world', type: String, default: '' },
    };
    for (const [id, shape] of Object.entries(expected)) {
      const config = env.settings.settings.get(id);
      expect(config, id).toMatchObject({ ...shape, config: true });
      expect(typeof getProperty(en, config?.name), `${id} name`).toBe('string');
      expect(typeof getProperty(en, config?.hint), `${id} hint`).toBe('string');
    }
  });

  it('no longer registers the device or auto-connect settings (AVSettings owns them)', () => {
    for (const legacy of ['autoConnect', 'defaultAudioDevice', 'defaultVideoDevice']) {
      expect(env.settings.settings.has(`mediasoup-vtt.${legacy}`)).toBe(false);
    }
  });

  it('registers one restricted menu whose type is the ApplicationV2 config dialog', () => {
    expect([...env.settings.menus.keys()]).toEqual([`mediasoup-vtt.${CONFIG_MENU_KEY}`]);
    const menu = env.settings.menus.get(`mediasoup-vtt.${CONFIG_MENU_KEY}`);
    expect(menu?.type).toBe(MediaSoupConfigDialog);
    expect(menu?.type.prototype).toBeInstanceOf(ApplicationV2);
    expect(menu?.restricted).toBe(true);
    for (const key of ['name', 'label', 'hint']) {
      expect(typeof getProperty(en, menu?.[key]), key).toBe('string');
    }
  });

  it('installs a single renderSettingsConfig handler, however often it is set up', () => {
    setupSettingsHooks();
    setupSettingsHooks();
    const handlers = env.hooks.handlers('renderSettingsConfig');
    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.fn).toBe(onRenderSettingsConfig);
  });

  it('reads settings back through game.settings.get (defaults, then stored values)', async () => {
    expect(env.settings.get('mediasoup-vtt', 'mediaSoupServerUrl')).toBe('');
    await env.settings.set('mediasoup-vtt', 'debugLogging', true);
    expect(env.settings.get('mediasoup-vtt', 'debugLogging')).toBe(true);
    await env.settings.set('mediasoup-vtt', 'debugLogging', false);
  });
});

describe('renderSettingsConfig with an HTMLElement (v13+/v14)', () => {
  it('injects the localized help box into the module category once, however often the hook runs', () => {
    const root = settingsPage('section');
    env.hooks.callAll('renderSettingsConfig', {}, root, {}, {});
    env.hooks.callAll('renderSettingsConfig', {}, root, {}, {});
    onRenderSettingsConfig({}, root);

    const boxes = root.querySelectorAll(`.${SETTINGS_HELP_CLASS}`);
    expect(boxes).toHaveLength(1);
    const section = root.querySelector('section[data-tab="mediasoup-vtt"]');
    expect(boxes[0]?.parentElement).toBe(section);
    expect(boxes[0]?.textContent).toContain(en.MEDIASOUPVTT.SettingsHelp.Title);
    expect(boxes[0]?.querySelectorAll('li')).toHaveLength(3);
    expect(boxes[0]?.textContent).toContain(en.MEDIASOUPVTT.SettingsHelp.Step2);
    // Never into the sidebar nav button that shares data-tab.
    expect(root.querySelector('nav')?.querySelector(`.${SETTINGS_HELP_CLASS}`)).toBeNull();
  });

  it('finds the category in a div.tab panel and, as a fallback, around the module inputs', () => {
    const tab = settingsPage('div-tab');
    onRenderSettingsConfig({}, tab);
    expect(tab.querySelector(`div.tab > .${SETTINGS_HELP_CLASS}`)).not.toBeNull();
    expect(tab.querySelector(`button .${SETTINGS_HELP_CLASS}`)).toBeNull();

    // Only the [data-category] panel and the nav button CategoryBrowser needs.
    const cb = settingsPage('core-cb');
    onRenderSettingsConfig({}, cb);
    const help = cb.querySelectorAll(`.${SETTINGS_HELP_CLASS}`);
    expect(help).toHaveLength(1);
    expect(help[0]?.parentElement?.dataset.category).toBe('mediasoup-vtt');
    expect(cb.querySelector(`nav .${SETTINGS_HELP_CLASS}`)).toBeNull();

    const bare = settingsPage('input-only');
    expect(findModuleSection(bare)?.tagName).toBe('FIELDSET');
    onRenderSettingsConfig({}, bare);
    expect(bare.querySelector(`fieldset > .${SETTINGS_HELP_CLASS}`)).not.toBeNull();
  });

  it('leaves pages without this module untouched and ignores a non-HTMLElement (jQuery) argument', () => {
    const other = document.createElement('div');
    other.innerHTML = '<section class="tab" data-tab="core"><input name="core.language"></section>';
    onRenderSettingsConfig({}, other);
    expect(other.querySelector(`.${SETTINGS_HELP_CLASS}`)).toBeNull();

    const root = settingsPage('section');
    const jqueryLike = { 0: root, length: 1, find: () => ({ length: 0 }) };
    expect(() => onRenderSettingsConfig({}, jqueryLike)).not.toThrow();
    expect(root.querySelector(`.${SETTINGS_HELP_CLASS}`)).toBeNull();
  });

  it('does not re-render the application from inside its own render hook', () => {
    const app = { render: vi.fn() };
    onRenderSettingsConfig(app, settingsPage('section'));
    expect(app.render).not.toHaveBeenCalled();
  });

  it('shows "Not active" when core A/V uses another client, even one named MediaSoupAVClient', () => {
    const root = settingsPage('section');
    env.game.webrtc = undefined;
    const avSettings = new AVSettings();
    env.game.webrtc = { client: new SimplePeerAVClient({}, {}), settings: avSettings };
    onRenderSettingsConfig({}, root);
    expect(statusOf(root)).toEqual({ state: 'inactive', text: en.MEDIASOUPVTT.Status.Inactive });

    // A look-alike: same class name, not this module's client.
    const lookAlike = { MediaSoupAVClient: class {} }.MediaSoupAVClient;
    expect(lookAlike.name).toBe('MediaSoupAVClient');
    env.game.webrtc = {
      client: Object.assign(new lookAlike(), { isConnected: true, settings: avSettings }),
    };
    onRenderSettingsConfig({}, root);
    expect(statusOf(root).state).toBe('inactive');
  });

  it('shows "Enabled" / "Connected" for MediaSoupAVClient, and updates the same indicator in place', () => {
    const root = settingsPage('section');
    const master = new AVMaster(new AVSettings());
    env.game.webrtc = master;
    expect(master.client).toBeInstanceOf(MediaSoupAVClient);
    onRenderSettingsConfig({}, root);
    expect(statusOf(root)).toEqual({ state: 'active', text: en.MEDIASOUPVTT.Status.Active });

    vi.spyOn(master.client, 'isConnected', 'get').mockReturnValue(true);
    onRenderSettingsConfig({}, root);
    expect(statusOf(root)).toEqual({ state: 'connected', text: en.MEDIASOUPVTT.Status.Connected });
    expect(root.querySelectorAll(`.${STATUS_INDICATOR_CLASS}`)).toHaveLength(1);

    master.settings.world.mode = AVSettings.AV_MODES.DISABLED;
    onRenderSettingsConfig({}, root);
    expect(statusOf(root).state).toBe('inactive');
  });
});

describe('server setting changes', () => {
  it('reconnect A/V once, debounced, when the URL or token changes', async () => {
    vi.useFakeTimers();
    const master = new AVMaster(new AVSettings());
    const connect = vi.spyOn(master, 'connect').mockResolvedValue(true);
    env.game.webrtc = master;
    env.notifications.info.mockClear();

    await env.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'wss://a.example');
    await env.settings.set('mediasoup-vtt', 'mediaSoupAuthToken', 'token-2');
    expect(connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(env.notifications.info).toHaveBeenCalledWith(en.MEDIASOUPVTT.Notifications.Reconnecting);
  });

  it('does not reconnect when A/V is disabled or another client is active', async () => {
    vi.useFakeTimers();
    const master = new AVMaster(new AVSettings({ mode: AVSettings.AV_MODES.DISABLED }));
    const connect = vi.spyOn(master, 'connect').mockResolvedValue(false);
    env.game.webrtc = master;
    await env.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'wss://b.example');
    await vi.advanceTimersByTimeAsync(600);
    expect(connect).not.toHaveBeenCalled();

    const other = { client: new SimplePeerAVClient({}, {}), connect: vi.fn() };
    env.game.webrtc = other;
    await env.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'wss://c.example');
    await vi.advanceTimersByTimeAsync(600);
    expect(other.connect).not.toHaveBeenCalled();
  });
});
