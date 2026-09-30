/**
 * Playwright global setup for the Foundry e2e tier.
 *
 * Expects a Foundry server at FOUNDRY_URL whose Data/ holds the fixture
 * world and system (scripts/prepare-data.ts) and this module's dist/ at
 * Data/modules/mediasoup-vtt (scripts/run-foundry.sh does both). Then:
 *
 *  1. starts the real Rust SFU on 127.0.0.1 (the browsers run on this host;
 *     only the Foundry web server is in the container);
 *  2. gets past license/EULA, admin login and Setup to the running world
 *     and logs in as the GM;
 *  3. enables the module (core.moduleConfiguration), sets the A/V mode to
 *     Audio & Video (core.rtcWorldSettings) and creates a TRUSTED player
 *     (core grants BROADCAST_AUDIO/VIDEO to TRUSTED by default), then reloads;
 *  4. points the module's world settings at the SFU (URL + token);
 *  5. writes test-results/foundry-e2e/state.json for the specs.
 *
 * Every step is idempotent, so it also works against a harness world that a
 * previous run already provisioned.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { startSfu } from '../sfu/support/sfu-server.js';
import {
  ARTIFACT_DIR,
  CHROMIUM_ARGS,
  FOUNDRY_URL,
  GM_NAME,
  GM_PASSWORD,
  MODULE_ID,
  PLAYER_NAME,
  RTC_PORTS,
  STATE_FILE,
  type SuiteState,
  WORLD_ID,
} from './support/env.js';
import { dumpPage, joinWorld, reloadGame, waitForFoundryHttp } from './support/foundry-session.js';

interface WorldReport {
  error?: string;
  changed: string[];
  gmId: string;
  playerId: string;
  isGM: boolean;
  version: string;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  console.log(`[foundry-e2e] Waiting for Foundry at ${FOUNDRY_URL} ...`);
  await waitForFoundryHttp();

  const token = `foundry-e2e-${Math.random().toString(36).slice(2)}`;
  const sfu = await startSfu({
    token,
    rtcMinPort: RTC_PORTS.min,
    rtcMaxPort: RTC_PORTS.max,
    logName: 'sfu-foundry',
  });
  console.log(`[foundry-e2e] SFU ${sfu.url} (log ${sfu.logFile})`);

  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    args: CHROMIUM_ARGS,
  });
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`[foundry-e2e] pageerror: ${error.message}`));

  let state: SuiteState;
  try {
    await page.goto(`${FOUNDRY_URL}/`);
    // Global setup is not traced, so it alone may type the license/admin keys.
    await joinWorld(page, WORLD_ID, GM_NAME, GM_PASSWORD, { provision: true });

    const world = (await page.evaluate(
      async ({ moduleId, playerName }) => {
        const g = globalThis as any;
        const { game, foundry, CONFIG } = g;
        const changed: string[] = [];
        const version = String(game.release?.version ?? game.version);
        const base = { changed, gmId: game.user.id, playerId: '', isGM: game.user.isGM, version };
        if (!game.user.isGM) return { ...base, error: `${game.user.name} is not a Gamemaster` };
        if (!game.modules.get(moduleId)) {
          return {
            ...base,
            error: `Module ${moduleId} is not installed: mount dist/ at Data/modules/${moduleId}.`,
          };
        }

        // Enable the module, as Manage Modules does.
        const modules = foundry.utils.deepClone(
          game.settings.get('core', 'moduleConfiguration') ?? {},
        );
        if (modules[moduleId] !== true) {
          modules[moduleId] = true;
          await game.settings.set('core', 'moduleConfiguration', modules);
          changed.push('moduleConfiguration');
        }

        // A/V mode: Audio & Video, as Configure Audio/Video does.
        const AV_MODES = foundry.av.AVSettings.AV_MODES;
        const current = game.settings.get('core', 'rtcWorldSettings');
        const rtc =
          typeof current?.toObject === 'function'
            ? current.toObject()
            : foundry.utils.deepClone(current ?? {});
        if (rtc.mode !== AV_MODES.AUDIO_VIDEO) {
          rtc.mode = AV_MODES.AUDIO_VIDEO;
          await game.settings.set('core', 'rtcWorldSettings', rtc);
          changed.push('rtcWorldSettings');
        }

        // The player: TRUSTED holds BROADCAST_AUDIO and BROADCAST_VIDEO by default.
        const TRUSTED = foundry.CONST.USER_ROLES.TRUSTED;
        let player = game.users.getName(playerName);
        if (!player) {
          player = await CONFIG.User.documentClass.create({ name: playerName, role: TRUSTED });
          changed.push('player');
        } else if (player.role < TRUSTED) {
          await player.update({ role: TRUSTED });
          changed.push('player-role');
        }
        return { ...base, playerId: player.id };
      },
      { moduleId: MODULE_ID, playerName: PLAYER_NAME },
    )) as WorldReport;
    if (world.error) throw new Error(`[foundry-e2e] ${world.error}`);
    console.log(
      `[foundry-e2e] Foundry ${world.version}; world "${WORLD_ID}"; ` +
        `changed: ${world.changed.join(', ') || 'nothing'}`,
    );

    // Module scripts load only at page load: reload to activate the module and the A/V mode.
    await reloadGame(page, WORLD_ID, GM_NAME, GM_PASSWORD, { provision: true });

    const configured = await page.evaluate(
      async ({ moduleId, url, sfuToken }) => {
        const g = globalThis as any;
        const { game, foundry } = g;
        if (game.modules.get(moduleId)?.active !== true) {
          return { error: `Module ${moduleId} is still inactive after enabling it and reloading.` };
        }
        if (!game.settings.settings.has(`${moduleId}.mediaSoupServerUrl`)) {
          return { error: `Module ${moduleId} is active but registered no settings.` };
        }
        await game.settings.set(moduleId, 'mediaSoupServerUrl', url);
        await game.settings.set(moduleId, 'mediaSoupAuthToken', sfuToken);
        return {
          error: undefined,
          avMode: game.webrtc?.settings?.world?.mode,
          audioVideo: foundry.av.AVSettings.AV_MODES.AUDIO_VIDEO,
        };
      },
      { moduleId: MODULE_ID, url: sfu.url, sfuToken: token },
    );
    if (configured.error) throw new Error(`[foundry-e2e] ${configured.error}`);
    if (configured.avMode !== configured.audioVideo) {
      throw new Error(
        `[foundry-e2e] A/V mode is ${configured.avMode} after reload, expected AUDIO_VIDEO ` +
          `(${configured.audioVideo}).`,
      );
    }

    state = {
      foundryUrl: FOUNDRY_URL,
      worldId: WORLD_ID,
      sfuUrl: sfu.url,
      sfuToken: token,
      sfuLog: sfu.logFile,
      gmId: world.gmId,
      playerId: world.playerId,
      foundryVersion: world.version,
    };
  } catch (error) {
    const dump = await dumpPage(page, 'global-setup-failed');
    console.log(`[foundry-e2e] Provisioning failed; page saved to ${dump}.png/.html`);
    await browser.close();
    await sfu.stop();
    throw error;
  }
  await browser.close();

  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`[foundry-e2e] Provisioned: ${JSON.stringify(state)}`);

  return async () => {
    await sfu.stop();
  };
}
