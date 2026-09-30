/**
 * The module under a real Foundry server: it loads, registers itself as the
 * core A/V client, registers its settings and menu, logs nothing alarming,
 * and its UI renders as ApplicationV2 against core's real DOM.
 */

import { describe, isDeprecation, isFromModule, isProblem } from './support/console-capture.js';
import {
  ALLOW_CORE_DEPRECATIONS,
  EXPECTED_FOUNDRY_VERSION,
  MODULE_ID,
  WORLD_ID,
} from './support/env.js';
import { clientStatus, expectConnected } from './support/av-probe.js';
import { expect, test } from './support/fixtures.js';

test('runs the Foundry build under test with the module active in the fixture world', async ({
  login,
  state,
}) => {
  const gm = await login('gm');
  const report = await gm.page.evaluate((moduleId) => {
    const g = globalThis as any;
    const mod = g.game.modules.get(moduleId);
    return {
      version: String(g.game.release?.version ?? g.game.version),
      world: g.game.world?.id,
      isGM: g.game.user?.isGM === true,
      moduleActive: mod?.active === true,
      esmodules: [...(mod?.esmodules ?? [])],
    };
  }, MODULE_ID);

  if (EXPECTED_FOUNDRY_VERSION) {
    expect(report.version, 'the server is the Foundry build this run targets').toBe(
      EXPECTED_FOUNDRY_VERSION,
    );
  }
  expect(report.version).toBe(state.foundryVersion);
  expect(report.world).toBe(WORLD_ID);
  expect(report.isGM).toBe(true);
  expect(report.moduleActive, `game.modules.get('${MODULE_ID}').active`).toBe(true);
  expect(report.esmodules).toEqual(['mediasoup-vtt.mjs']);
});

test('replaces core A/V: CONFIG.WebRTC.clientClass is MediaSoupAVClient and AVMaster uses it', async ({
  login,
}) => {
  const gm = await login('gm');
  const report = await gm.page.evaluate(() => {
    const g = globalThis as any;
    const { game, foundry, CONFIG } = g;
    const cls = CONFIG.WebRTC.clientClass;
    const client = game.webrtc?.client;
    return {
      clientClassName: cls?.name,
      extendsAVClient: cls?.prototype instanceof foundry.av.AVClient,
      isCoreSimplePeer:
        !!foundry.av.clients?.SimplePeerAVClient && cls === foundry.av.clients.SimplePeerAVClient,
      clientIsInstance: !!client && client instanceof cls,
      clientConstructorName: client?.constructor?.name,
      debugAliasIsClient: g.MediaSoupVTT_Client === client && !!client,
      avMode: game.webrtc?.settings?.world?.mode,
      audioVideo: foundry.av.AVSettings.AV_MODES.AUDIO_VIDEO,
    };
  });
  expect(report.clientClassName).toBe('MediaSoupAVClient');
  expect(report.extendsAVClient, 'clientClass extends foundry.av.AVClient').toBe(true);
  expect(report.isCoreSimplePeer).toBe(false);
  expect(report.clientIsInstance, 'game.webrtc.client instanceof clientClass').toBe(true);
  expect(report.clientConstructorName).toBe('MediaSoupAVClient');
  expect(report.debugAliasIsClient, 'window.MediaSoupVTT_Client aliases game.webrtc.client').toBe(
    true,
  );
  expect(report.avMode, 'world A/V mode is Audio & Video').toBe(report.audioVideo);

  // Core (AVMaster) connected it to the SFU from the world settings.
  await expectConnected(gm.page, 'GM');
  const status = await clientStatus(gm.page);
  expect(status.clientClass).toBe('MediaSoupAVClient');
  expect(status.audioEnabled, 'GM captured a microphone track').toBe(true);
  expect(status.videoEnabled, 'GM captured a camera track').toBe(true);
});

test('registers exactly its three settings and the configuration menu', async ({
  login,
  state,
}) => {
  const gm = await login('gm');
  const report = await gm.page.evaluate((ns) => {
    const g = globalThis as any;
    const prefix = `${ns}.`;
    const settings = [...g.game.settings.settings.entries()]
      .filter(([id]: [string]) => id.startsWith(prefix))
      .map(([id, s]: [string, any]) => ({
        key: id.slice(prefix.length),
        scope: s.scope,
        config: s.config === true,
        // A primitive constructor (Boolean) or, if core wrapped it, a DataField (BooleanField).
        type: String(
          typeof s.type === 'function' ? s.type.name : s.type?.constructor?.name,
        ).replace(/Field$/, ''),
      }))
      .sort((a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key));
    const menus = [...g.game.settings.menus.entries()]
      .filter(([id]: [string]) => id.startsWith(prefix))
      .map(([id, m]: [string, any]) => ({
        key: id.slice(prefix.length),
        restricted: m.restricted === true,
        type: m.type?.name,
      }));
    return {
      settings,
      menus,
      serverUrl: g.game.settings.get(ns, 'mediaSoupServerUrl'),
      hasToken: g.game.settings.get(ns, 'mediaSoupAuthToken') !== '',
    };
  }, MODULE_ID);

  expect(report.settings).toEqual([
    { key: 'debugLogging', scope: 'client', config: true, type: 'Boolean' },
    { key: 'mediaSoupAuthToken', scope: 'world', config: true, type: 'String' },
    { key: 'mediaSoupServerUrl', scope: 'world', config: true, type: 'String' },
  ]);
  expect(report.menus).toEqual([
    { key: 'configDialog', restricted: true, type: 'MediaSoupConfigDialog' },
  ]);
  // The world settings global setup saved survived the round trip through the server.
  expect(report.serverUrl).toBe(state.sfuUrl);
  expect(report.hasToken).toBe(true);
});

test('loads without errors, warnings or deprecations from the module', async ({ login }) => {
  const gm = await login('gm');
  // Let the A/V connect (and anything it logs) finish before judging the log.
  await expectConnected(gm.page, 'GM');
  await gm.page.waitForTimeout(3_000);

  const entries = gm.console;
  const text = entries.map((e) => e.text);
  // The recorder saw the module's own output, so an empty problem list means something.
  expect(
    text.some((t) => t.includes('MediaSoupVTT |') && t.includes('Initializing MediaSoupVTT')),
    'the init hook ran and its log was captured',
  ).toBe(true);
  expect(
    text.some((t) => t.includes('MediaSoupAVClient is the active A/V client.')),
    'the ready hook found MediaSoupAVClient active',
  ).toBe(true);
  // Core's own log line from AVMaster#connect after client.connect() resolved true.
  expect(
    text.some((t) => t.includes('Connected to the MediaSoupAVClient Audio/Video client')),
    'core AVMaster reports connecting through MediaSoupAVClient',
  ).toBe(true);

  const fromModule = entries.filter((e) => isProblem(e) && isFromModule(e));
  expect(describe(fromModule), 'console errors/warnings raised by or about the module').toEqual([]);

  const deprecations = entries.filter((e) => isProblem(e) && isDeprecation(e));
  if (deprecations.length > 0) {
    test.info().annotations.push({
      type: 'deprecations',
      description: describe(deprecations).join('\n'),
    });
  }
  const blocking = ALLOW_CORE_DEPRECATIONS ? deprecations.filter(isFromModule) : deprecations;
  expect(describe(blocking), 'deprecation warnings during load').toEqual([]);
});

test('the configuration menu opens an ApplicationV2 form showing the saved server', async ({
  login,
  state,
}) => {
  const gm = await login('gm');
  const opened = await gm.page.evaluate(async (ns) => {
    const g = globalThis as any;
    const Menu = g.game.settings.menus.get(`${ns}.configDialog`)?.type;
    const app = new Menu();
    await app.render({ force: true });
    g.__mediasoupE2eDialog = app;
    return {
      id: app.id,
      isV2: app instanceof g.foundry.applications.api.ApplicationV2,
      rendered: app.rendered === true,
      tag: app.element?.tagName,
      title: app.title,
    };
  }, MODULE_ID);

  expect(opened.isV2, 'the dialog is an ApplicationV2').toBe(true);
  expect(opened.rendered).toBe(true);
  expect(opened.tag).toBe('FORM');
  expect(opened.title, 'the window title is localized').not.toMatch(/^MEDIASOUPVTT\./);
  expect(opened.title.length).toBeGreaterThan(0);

  const dialog = gm.page.locator(`#${opened.id}`);
  await expect(dialog).toBeVisible();
  // The template was fetched from modules/mediasoup-vtt/templates/ and filled by _prepareContext.
  await expect(dialog.locator('input[name="serverUrl"]')).toHaveValue(state.sfuUrl);
  await expect(dialog.locator('input[name="authToken"]')).toHaveValue(state.sfuToken);
  await expect(dialog.locator('button[type="submit"]')).toHaveCount(1);

  await gm.page.evaluate(() => (globalThis as any).__mediasoupE2eDialog.close());
  await expect(dialog).toHaveCount(0);
});

test('the Settings page shows the module help block once, in the module section', async ({
  login,
}) => {
  const gm = await login('gm');
  await expectConnected(gm.page, 'GM');
  const report = await gm.page.evaluate(async (ns) => {
    const g = globalThis as any;
    const Cls = g.foundry.applications.settings.SettingsConfig;
    const app = g.game.settings.sheet instanceof Cls ? g.game.settings.sheet : new Cls();
    const inspect = () => {
      const blocks = [...app.element.querySelectorAll('.mediasoup-settings-help')] as HTMLElement[];
      const block = blocks[0];
      const status = block?.querySelector<HTMLElement>('.mediasoup-status-indicator');
      // The block must sit in the container that holds this module's own fields.
      const section: HTMLElement | null = block?.parentElement ?? null;
      return {
        count: blocks.length,
        inModuleSection: !!section?.querySelector(`[name="${ns}.mediaSoupServerUrl"]`),
        state: status?.dataset.state ?? null,
        stepCount: block?.querySelectorAll('ol > li').length ?? 0,
        localized: !(block?.textContent ?? '').includes('MEDIASOUPVTT.'),
      };
    };
    await app.render({ force: true });
    const first = inspect();
    await app.render({ force: true });
    const second = inspect();
    await app.close();
    return { first, second, isV2: app instanceof g.foundry.applications.api.ApplicationV2 };
  }, MODULE_ID);

  expect(report.isV2).toBe(true);
  expect(report.first.count, 'renderSettingsConfig injected the help block').toBe(1);
  expect(report.first.inModuleSection, 'next to the module settings').toBe(true);
  expect(report.first.stepCount).toBe(3);
  expect(report.first.localized, 'help text is localized').toBe(true);
  expect(report.first.state, 'status shows the live SFU connection').toBe('connected');
  expect(report.second.count, 're-rendering does not duplicate the block').toBe(1);
});
