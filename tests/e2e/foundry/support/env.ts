/**
 * Configuration of the Foundry e2e tier, read from the environment.
 *
 * The suite drives a real Foundry VTT server (the felddy/foundryvtt Docker
 * image in CI, or the local foundryvtt-harness) with this module mounted
 * from `dist/`. Nothing here starts Foundry: see scripts/run-foundry.sh.
 */

import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/** The module under test (module.json `id`). */
export const MODULE_ID = 'mediasoup-vtt';

/** The world fixture (scripts/prepare-data.ts writes it; FOUNDRY_WORLD launches it). */
export const WORLD_ID = process.env.FOUNDRY_E2E_WORLD || 'mediasoup-e2e';

/** The minimal game system the world fixture uses (no code, no document types). */
export const SYSTEM_ID = 'mediasoup-e2e-system';

/**
 * The GM account. Foundry creates a password-less "Gamemaster" user in every
 * new world; FOUNDRY_E2E_GM_NAME / FOUNDRY_E2E_GM_PASSWORD override it for a
 * world that renamed it or set a password (e.g. a harness world).
 */
export const GM_NAME = process.env.FOUNDRY_E2E_GM_NAME || 'Gamemaster';
export const GM_PASSWORD = process.env.FOUNDRY_E2E_GM_PASSWORD ?? '';

/** The player account global setup creates (TRUSTED: may broadcast audio + video). */
export const PLAYER_NAME = process.env.FOUNDRY_E2E_PLAYER_NAME || 'E2E Player';

/**
 * Where Foundry listens, as the browser sees it. Loopback (127.0.0.1 or
 * localhost) is a secure context, so getUserMedia works over plain http.
 */
export const FOUNDRY_URL = (process.env.FOUNDRY_URL || 'http://127.0.0.1:30000').replace(
  /\/+$/,
  '',
);

/** Admin password of the Setup screen (felddy: FOUNDRY_ADMIN_KEY). */
export const ADMIN_KEY = process.env.FOUNDRY_ADMIN_KEY ?? '';

/** Used only if Foundry shows the license-key activation screen. */
export const LICENSE_KEY = process.env.FOUNDRY_LICENSE_KEY ?? '';

/**
 * The Foundry build the run is meant to test, e.g. "14.368" (CI sets it from
 * the matrix). When set, the specs assert the server really is that build.
 */
export const EXPECTED_FOUNDRY_VERSION = process.env.FOUNDRY_VERSION ?? '';

/**
 * Core-originated deprecation warnings (no module or system code on the
 * stack) fail the load spec unless this is "1". Deprecations raised from this
 * module's code always fail.
 */
export const ALLOW_CORE_DEPRECATIONS = process.env.FOUNDRY_E2E_ALLOW_CORE_DEPRECATIONS === '1';

/** Artifacts: provisioning screenshots/HTML, the state file, SFU logs. */
export const ARTIFACT_DIR = path.join(REPO_ROOT, 'test-results/foundry-e2e');

/** Written by global setup, read by the specs (worker processes do not share memory). */
export const STATE_FILE = path.join(ARTIFACT_DIR, 'state.json');

/** RTC ports of the SFU this tier starts (disjoint from the SFU tier's 40000-40149). */
export const RTC_PORTS = { min: 40200, max: 40299 } as const;

export interface SuiteState {
  foundryUrl: string;
  worldId: string;
  sfuUrl: string;
  sfuToken: string;
  sfuLog: string;
  gmId: string;
  playerId: string;
  foundryVersion: string;
}

/**
 * Chromium flags for every browser of this tier (global setup and specs):
 * fake camera + microphone without a permission prompt, and unmuted
 * autoplay of remote media without a user gesture.
 */
export const CHROMIUM_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
];
