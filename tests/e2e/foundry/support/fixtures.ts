/**
 * Playwright fixtures for the Foundry e2e tier: `state` (what global setup
 * provisioned) and `login(role)`, which opens a fresh browser context,
 * starts recording its console, and logs that user into the fixture world.
 */

import { readFileSync } from 'node:fs';
import { test as base, type BrowserContext, type Page } from '@playwright/test';
import { type ConsoleEntry, captureConsole, describe } from './console-capture.js';
import { GM_NAME, GM_PASSWORD, PLAYER_NAME, STATE_FILE, type SuiteState, WORLD_ID } from './env.js';
import { joinWorld } from './foundry-session.js';

export interface Session {
  role: 'gm' | 'player';
  name: string;
  userId: string;
  context: BrowserContext;
  page: Page;
  /** Everything the page logged since before its first navigation. */
  console: ConsoleEntry[];
}

interface Fixtures {
  login: (role: 'gm' | 'player') => Promise<Session>;
}

interface WorkerFixtures {
  state: SuiteState;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  state: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures must destructure.
    async ({}, use) => {
      const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SuiteState;
      await use(state);
    },
    { scope: 'worker' },
  ],

  login: async ({ browser, state }, use, testInfo) => {
    const sessions: Session[] = [];
    await use(async (role) => {
      const context = await browser.newContext({
        baseURL: state.foundryUrl,
        permissions: ['camera', 'microphone'],
        viewport: { width: 1600, height: 1000 },
      });
      const page = await context.newPage();
      const consoleEntries = captureConsole(page);
      const name = role === 'gm' ? GM_NAME : PLAYER_NAME;
      const session: Session = {
        role,
        name,
        userId: role === 'gm' ? state.gmId : state.playerId,
        context,
        page,
        console: consoleEntries,
      };
      sessions.push(session);
      await page.goto('/join');
      await joinWorld(page, WORLD_ID, name, role === 'gm' ? GM_PASSWORD : '');
      return session;
    });
    for (const session of sessions) {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach(`console-${session.role}.txt`, {
          body: describe(session.console).join('\n'),
          contentType: 'text/plain',
        });
        const shot = await session.page.screenshot({ fullPage: true }).catch(() => null);
        if (shot) {
          await testInfo.attach(`screen-${session.role}.png`, {
            body: shot,
            contentType: 'image/png',
          });
        }
      }
      await session.context.close().catch(() => undefined);
    }
  },
});

export { expect } from '@playwright/test';
