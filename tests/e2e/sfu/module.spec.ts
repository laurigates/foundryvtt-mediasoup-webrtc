/**
 * The real bundle loads on a v14-shaped Foundry and registers itself the way
 * core expects: MediaSoupAVClient as CONFIG.WebRTC.clientClass (at import
 * time), instantiated by AVMaster, with its settings, menu and hooks.
 */

import { expect, test } from './support/peer.js';

const MODULE_ID = 'mediasoup-vtt';

test('the bundle registers MediaSoupAVClient as the core A/V client', async ({ peers }) => {
  const a = await peers({ user: 'gm', users: ['gm', 'player'] });

  const report = await a.page.evaluate(() => {
    const e2e = window.__e2e;
    const cls = window.CONFIG.WebRTC.clientClass;
    const base = window.foundry.av.AVClient;
    const client = window.game.webrtc.client;
    return {
      manifest: e2e.boot.manifest,
      clientClassAfterImport: e2e.boot.clientClassAfterImport,
      clientClassName: cls.name,
      extendsAVClient: cls.prototype instanceof base,
      isCoreDefault: cls === window.foundry.av.clients.SimplePeerAVClient,
      instanceOfClientClass: client instanceof cls,
      debugAliasIsClient: window.MediaSoupVTT_Client === client,
      notOverridden: e2e.abstractMethods.filter(
        (name: string) => cls.prototype[name] === base.prototype[name],
      ),
      mediasoupVersion: window.mediasoupClient?.version,
      hookCalls: e2e.hookCalls,
      hookErrors: e2e.hookErrors,
      pageErrors: e2e.pageErrors,
      consoleErrors: e2e.consoleErrors,
      stylesInjected: !!document.getElementById('mediasoup-vtt-styles'),
    };
  });

  expect(report.manifest).toEqual({ id: MODULE_ID, esmodules: ['mediasoup-vtt.mjs'] });
  // Assigned by the module script itself, before any hook ran.
  expect(report.clientClassAfterImport).toBe('MediaSoupAVClient');
  expect(report.clientClassName).toBe('MediaSoupAVClient');
  expect(report.extendsAVClient).toBe(true);
  expect(report.isCoreDefault).toBe(false);
  expect(report.instanceOfClientClass).toBe(true);
  expect(report.debugAliasIsClient).toBe(true);
  expect(report.notOverridden).toEqual([]);
  expect(report.mediasoupVersion).toMatch(/^3\.24\./);
  expect(report.hookCalls).toEqual(expect.arrayContaining(['init', 'setup', 'ready']));
  expect(report.stylesInjected).toBe(true);
  expect(report.pageErrors).toEqual([]);
  expect(report.hookErrors).toEqual([]);
  // The `ready` hook warns if AVMaster ended up with another client.
  expect(report.consoleErrors.map((e: { text: string }) => e.text).join('\n')).not.toMatch(
    /not MediaSoupAVClient/,
  );
});

test('the module settings, menu and Settings-page hook are registered', async ({ peers }) => {
  const a = await peers({ user: 'gm', users: ['gm'] });

  const registered = await a.page.evaluate((id) => {
    const settings = [...window.game.settings.settings.values()]
      .filter((s: { namespace: string }) => s.namespace === id)
      .map((s: { key: string; scope: string; config: boolean; type: unknown }) => ({
        key: s.key,
        scope: s.scope,
        config: s.config,
        type: (s.type as { name?: string })?.name,
      }))
      .sort((x: { key: string }, y: { key: string }) => x.key.localeCompare(y.key));
    const menus = [...window.game.settings.menus.values()]
      .filter((m: { namespace: string }) => m.namespace === id)
      .map((m: { key: string; restricted: boolean; type: { name: string } }) => ({
        key: m.key,
        restricted: m.restricted,
        type: m.type?.name,
      }));
    return {
      settings,
      menus,
      settingsHooks: window.Hooks.events.renderSettingsConfig?.length ?? 0,
    };
  }, MODULE_ID);

  expect(registered.settings).toEqual([
    { key: 'debugLogging', scope: 'client', config: true, type: 'Boolean' },
    { key: 'mediaSoupAuthToken', scope: 'world', config: true, type: 'String' },
    { key: 'mediaSoupServerUrl', scope: 'world', config: true, type: 'String' },
  ]);
  expect(registered.menus).toEqual([
    { key: 'configDialog', restricted: true, type: 'MediaSoupConfigDialog' },
  ]);
  expect(registered.settingsHooks).toBe(1);

  // The Settings page (an AppV2, so the hook gets an HTMLElement) gets one
  // help block with a live connection status, however often it renders.
  const renderSettings = () =>
    a.page.evaluate((id) => {
      let root = document.getElementById('e2e-settings');
      if (!root) {
        root = document.createElement('div');
        root.id = 'e2e-settings';
        root.innerHTML = `<section class="tab" data-tab="${id}"><div class="form-group"><input name="${id}.mediaSoupServerUrl"></div></section>`;
        document.body.append(root);
      }
      window.Hooks.callAll('renderSettingsConfig', {}, root);
      const helps = root.querySelectorAll('.mediasoup-settings-help');
      const status = root.querySelector<HTMLElement>('.mediasoup-status-indicator');
      return { helps: helps.length, state: status?.dataset.state, text: status?.textContent };
    }, MODULE_ID);

  const before = await renderSettings();
  expect(before.helps).toBe(1);
  expect(before.state).toBe('active');

  expect(await a.connect()).toBe(true);
  const after = await renderSettings();
  expect(after.helps).toBe(1);
  expect(after.state).toBe('connected');
  expect(after.text).not.toBe(before.text);
});

test('device discovery uses the browser devices', async ({ peers }) => {
  const a = await peers({ user: 'gm' });
  const sources = await a.page.evaluate(async () => {
    const client = window.game.webrtc.client;
    return {
      audio: Object.keys(await client.getAudioSources()).length,
      video: Object.keys(await client.getVideoSources()).length,
    };
  });
  // Chromium's fake capture devices.
  expect(sources.audio).toBeGreaterThan(0);
  expect(sources.video).toBeGreaterThan(0);
});
