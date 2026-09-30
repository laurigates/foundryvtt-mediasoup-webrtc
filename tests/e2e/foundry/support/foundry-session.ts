/**
 * Drive a real Foundry VTT server from the outside: get past the license,
 * admin and Setup screens to a running world, and log users into it.
 *
 * Foundry's pre-game screens differ between builds, so every step accepts
 * the known variants (checked against v13.351 and v14 up to 14.368):
 *  - /license: license-key activation form and/or the EULA ("I agree" +
 *    "Agree"). felddy writes the key into Config/license.json, but the EULA
 *    must still be signed in a browser on a fresh data volume.
 *  - /auth (or /setup with a password field): `input[name="adminPassword"]`.
 *  - /setup: a usage-data prompt, tours, then the world tile's
 *    `[data-action="worldLaunch"]`. The same launch is also available as
 *    POST /setup {action: "launchWorld", world}, used as a fallback.
 *  - /players (v14): the first-launch user-management gate
 *    (`form#manage-players`, "Save and Continue").
 *  - /join: v13 and v14 < 14.366 pick the user from `select[name="userid"]`;
 *    14.366+ uses a username text input (`#join-username`).
 *
 * Page-side code only touches public API (`game`, `foundry.*`, `CONFIG`,
 * `ui`), never deprecated globals, so it cannot itself trigger the
 * deprecation warnings the load spec checks for.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ADMIN_KEY, ARTIFACT_DIR, FOUNDRY_URL, LICENSE_KEY } from './env.js';

const log = (message: string) => console.log(`[foundry-e2e] ${message}`);

/** The pathname of the page's URL, or '' for about:blank / chrome-error pages. */
function currentPath(page: Page): string {
  const url = page.url();
  if (!url.startsWith('http')) return '';
  return new URL(url).pathname.replace(/\/+$/, '') || '/';
}

async function isVisible(page: Page, selector: string, timeout = 0): Promise<boolean> {
  const locator = page.locator(selector).filter({ visible: true }).first();
  if (timeout > 0) {
    return locator
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);
  }
  return locator.isVisible().catch(() => false);
}

/** Click through overlays: a DOM click, not a Playwright actionability-checked one. */
async function domClick(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector).filter({ visible: true }).first();
  if ((await locator.count()) === 0) return false;
  await locator.evaluate((el) => (el as HTMLElement).click());
  return true;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
}

/** Save a screenshot and the page HTML under test-results/foundry-e2e/ for post-mortems. */
export async function dumpPage(page: Page, name: string): Promise<string> {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const base = path.join(ARTIFACT_DIR, `${name}-${Date.now()}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => undefined);
  const html = await page.content().catch(() => '');
  writeFileSync(`${base}.html`, `<!-- ${page.url()} -->\n${html}`);
  return base;
}

/** Wait until Foundry answers HTTP at all (any status: it redirects by state). */
export async function waitForFoundryHttp(timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${FOUNDRY_URL}/`, { redirect: 'manual' });
      if (response.status > 0) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `Foundry did not answer at ${FOUNDRY_URL} within ${timeoutMs / 1000} s (${lastError}). ` +
      'Start it first: tests/e2e/foundry/scripts/run-foundry.sh (see tests/e2e/foundry/README.md).',
  );
}

/** Hide tours and decline the usage-data prompt; both can cover the Setup screen. */
async function dismissSetupOverlays(page: Page): Promise<void> {
  await page
    .addStyleTag({
      content:
        '.tour-overlay,#tour-overlay,.tour-fadeout,.tour,.nue-overlay,foundry-guide{display:none!important}',
    })
    .catch(() => undefined);
  const decline = [
    'dialog button[data-action="no"]',
    'dialog button[data-button="no"]',
    '.application button[data-action="no"]',
  ].join(', ');
  const hasUsagePrompt = await page
    .locator('dialog, .application, .window-app')
    .filter({ hasText: /usage data/i })
    .filter({ visible: true })
    .count()
    .catch(() => 0);
  if (hasUsagePrompt > 0) {
    log('Declining the usage-data prompt.');
    await domClick(page, decline);
    await page.waitForTimeout(500);
  }
}

async function handleLicense(page: Page): Promise<void> {
  // License-key activation (only when no key was installed).
  const keyInput = page
    .locator('input[name="licenseKey"], input[placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"]')
    .filter({ visible: true })
    .first();
  if ((await keyInput.count()) > 0) {
    if (!LICENSE_KEY) {
      throw new Error('Foundry asks for a license key, but FOUNDRY_LICENSE_KEY is not set.');
    }
    log('Submitting the license key.');
    await keyInput.fill(LICENSE_KEY);
    await keyInput.press('Enter');
    await settle(page);
    return;
  }

  // EULA: tick the agreement box, then "Agree" (this signs the license online).
  const checkbox = page
    .locator('#eula-agree, input[type="checkbox"][name="agree"], input[type="checkbox"]')
    .first();
  if ((await checkbox.count()) === 0) {
    const dump = await dumpPage(page, 'license-unknown');
    throw new Error(`Unrecognised /license screen; see ${dump}.png/.html`);
  }
  log('Accepting the EULA.');
  await checkbox.evaluate((el) => {
    const input = el as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const clicked =
    (await domClick(page, 'button#sign')) ||
    (await domClick(page, 'button[data-action="agree"]')) ||
    (await domClick(page, 'button[name="sign"]')) ||
    (await domClick(page, 'form button[type="submit"]'));
  if (!clicked) {
    const dump = await dumpPage(page, 'license-no-button');
    throw new Error(`No EULA agree button found; see ${dump}.png/.html`);
  }
  await page
    .waitForURL((url) => !url.pathname.startsWith('/license'), { timeout: 90_000 })
    .catch(() => undefined);
}

async function adminLogin(page: Page): Promise<void> {
  if (!ADMIN_KEY) {
    throw new Error('Foundry asks for the admin password, but FOUNDRY_ADMIN_KEY is not set.');
  }
  log('Logging in to the Setup screen.');
  const input = page.locator('input[name="adminPassword"]').filter({ visible: true }).first();
  await input.fill(ADMIN_KEY);
  await input.press('Enter');
  await page
    .waitForURL((url) => url.pathname.startsWith('/setup'), { timeout: 20_000 })
    .catch(() => undefined);
  await settle(page);
  if (await isVisible(page, '.notification.error')) {
    const text = await page.locator('.notification.error').first().innerText();
    throw new Error(`Admin login failed: ${text}`);
  }
}

async function submitPlayersGate(page: Page): Promise<void> {
  log('Submitting the first-launch user-management screen (/players).');
  const button = page
    .locator(
      [
        'form#manage-players button[type="submit"]',
        '#manage-players button[type="submit"]',
        'button[type="submit"].bright',
        'button:has-text("Save and Continue")',
        'button:has-text("Save Configuration")',
      ].join(', '),
    )
    .first();
  // The form's submit listener can bind a moment after the button shows up.
  for (let attempt = 1; attempt <= 5 && currentPath(page) === '/players'; attempt++) {
    await button.click({ timeout: 10_000 }).catch(() => undefined);
    await page
      .waitForURL((url) => url.pathname !== '/players', { timeout: 10_000 })
      .catch(() => undefined);
  }
}

async function launchWorld(page: Page, worldId: string): Promise<void> {
  await dismissSetupOverlays(page);
  const tile = `[data-package-id="${worldId}"]`;
  if (!(await isVisible(page, tile, 5_000))) {
    // The Worlds tab may not be the active one.
    await domClick(page, '[data-tab="worlds"]');
    await page.waitForTimeout(1_000);
  }

  if (await isVisible(page, tile, 10_000)) {
    log(`Launching world "${worldId}" from the Setup screen.`);
    await domClick(page, `${tile} [data-action="worldLaunch"]`);
    const left = await page
      .waitForURL((url) => /^\/(join|game|players)/.test(url.pathname), { timeout: 90_000 })
      .then(() => true)
      .catch(() => false);
    if (left) return;
    log('The launch button did not leave /setup; trying POST /setup {action: "launchWorld"}.');
  } else {
    log(`World tile "${worldId}" not shown on /setup; trying POST /setup {action: "launchWorld"}.`);
  }

  const result = await page.evaluate(async (world) => {
    const response = await fetch('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'launchWorld', world }),
    });
    return { status: response.status, body: (await response.text()).slice(0, 500) };
  }, worldId);
  log(`POST /setup launchWorld -> ${result.status} ${result.body}`);
  await page.goto(`${FOUNDRY_URL}/join`).catch(() => undefined);
  await settle(page);
  if (currentPath(page) === '/setup') {
    const dump = await dumpPage(page, 'launch-failed');
    throw new Error(
      `Could not launch world "${worldId}" (is it in Data/worlds? did prepare-data run?). ` +
        `See ${dump}.png/.html`,
    );
  }
}

/**
 * Options for the steps that type secrets. Playwright traces record the
 * arguments of `locator.fill()`, and the traces of failed tests are uploaded
 * as CI artifacts (which log masking does not cover), so only global setup,
 * which is not traced, may enter the license key or the admin key.
 */
export interface SecretOptions {
  /** Allow entering FOUNDRY_LICENSE_KEY / FOUNDRY_ADMIN_KEY (global setup only). */
  provision?: boolean;
}

function refuseSecret(page: Page, what: string): never {
  throw new Error(
    `Foundry asks for the ${what} at ${page.url()}, but only global setup may enter it ` +
      '(test contexts are traced). Did the server restart or leave the world after global setup?',
  );
}

/**
 * From whatever state the server is in, get to a running `worldId` and
 * return on its /join (or /game) page.
 */
export async function reachWorld(
  page: Page,
  worldId: string,
  { provision = false }: SecretOptions = {},
): Promise<'join' | 'game'> {
  let lastPath = '';
  for (let step = 1; step <= 40; step++) {
    if (!page.url().startsWith('http')) {
      await page.goto(`${FOUNDRY_URL}/`).catch(() => undefined);
      await settle(page);
    }
    const where = currentPath(page);
    if (where !== lastPath) log(`step ${step}: at ${where || page.url()}`);
    lastPath = where;

    if (where === '/game') return 'game';
    if (where === '/join') {
      // A running world, but maybe not ours (a harness world).
      const running = await page.evaluate(() => (globalThis as any).game?.world?.id ?? null);
      if (running && running !== worldId) {
        throw new Error(
          `Foundry is running world "${running}", not "${worldId}". ` +
            'Return to Setup (or restart with FOUNDRY_WORLD) first.',
        );
      }
      return 'join';
    }
    if (where === '/license') {
      if (!provision) refuseSecret(page, 'license (EULA / license key)');
      await handleLicense(page);
    } else if (where === '/auth' || (await isVisible(page, 'input[name="adminPassword"]'))) {
      if (!provision) refuseSecret(page, 'admin key');
      await adminLogin(page);
    } else if (where === '/setup') await launchWorld(page, worldId);
    else if (where === '/players') await submitPlayersGate(page);
    else {
      await page.goto(`${FOUNDRY_URL}/`).catch(() => undefined);
      await settle(page);
      if (currentPath(page) === where) await page.waitForTimeout(2_000);
    }
    await settle(page);
  }
  const dump = await dumpPage(page, 'reach-world-stuck');
  throw new Error(`Could not reach world "${worldId}" (stuck at ${page.url()}); see ${dump}.png`);
}

/** Wait for Game#ready and for AVMaster (`game.webrtc`) to exist. */
export async function waitForGameReady(page: Page, timeout = 120_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const g = (globalThis as any).game;
      return g?.ready === true && !!g.webrtc && !!g.user;
    },
    undefined,
    { timeout },
  );
}

/**
 * Log `userName` into the running world through the /join form and wait for
 * the game to be ready. Handles the v14 /players gate on the way.
 */
export async function joinWorld(
  page: Page,
  worldId: string,
  userName: string,
  password = '',
  options: SecretOptions = {},
): Promise<void> {
  if ((await reachWorld(page, worldId, options)) === 'game') {
    const current = await page.evaluate(() => (globalThis as any).game?.user?.name ?? null);
    if (current === userName) {
      await waitForGameReady(page);
      return;
    }
    await page.goto(`${FOUNDRY_URL}/join`);
    await settle(page);
  }

  const joinButton = page.locator('button[name="join"]').first();
  await joinButton.waitFor({ state: 'visible', timeout: 60_000 });

  const select = page.locator('select[name="userid"]');
  if ((await select.count()) > 0) {
    // v13 / v14 before 14.366: a user picker. Match the label exactly.
    const options = await select
      .locator('option')
      .evaluateAll((els) =>
        els.map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent?.trim() })),
      );
    const option = options.find((o) => o.label === userName);
    if (!option?.value) {
      const offered = options.map((o) => o.label).filter(Boolean);
      throw new Error(`The join page offers no user "${userName}"; it offers ${offered}.`);
    }
    await select.selectOption(option.value);
  } else {
    // 14.366+: a username text input with autocompletion.
    const username = page
      .locator('#join-username, input[name="username"], input[name="userid"]')
      .first();
    await username.fill(userName);
  }
  // The admin "Return to Setup" form on the same page uses name="adminPassword".
  const passwordInput = page.locator('input[name="password"]');
  if ((await passwordInput.count()) > 0) await passwordInput.first().fill(password);

  await joinButton.click();
  const landed = await page
    .waitForURL((url) => /^\/(game|players)/.test(url.pathname), { timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  if (!landed) {
    const dump = await dumpPage(page, `join-failed-${userName.replace(/\W+/g, '_')}`);
    throw new Error(`Logging in as "${userName}" did not reach /game; see ${dump}.png/.html`);
  }
  if (currentPath(page) === '/players') {
    await submitPlayersGate(page);
    if (currentPath(page) === '/join') {
      return joinWorld(page, worldId, userName, password, options);
    }
  }
  await waitForGameReady(page);
}

/** Reload the game page and wait until it is ready again (re-joining if the session was lost). */
export async function reloadGame(
  page: Page,
  worldId: string,
  userName: string,
  password = '',
  options: SecretOptions = {},
): Promise<void> {
  await page.reload();
  await settle(page);
  if (currentPath(page) !== '/game') {
    await joinWorld(page, worldId, userName, password, options);
    return;
  }
  await waitForGameReady(page);
}
