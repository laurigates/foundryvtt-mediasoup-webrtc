/**
 * Playwright global setup for the SFU e2e tier.
 *
 * Builds nothing: `dist/` (bun run build) and the SFU release binary
 * (cargo build --release in server/) must exist already. Starts:
 *  - the real Rust SFU on a free 127.0.0.1 port, with an auth token and a
 *    small RTC port range, announced as 127.0.0.1;
 *  - a static server with a snapshot of `dist/` (copied to
 *    test-results/e2e-dist, so a `bun run build` or `just dev` during the run
 *    cannot swap the bundle under test) at /modules/mediasoup-vtt/ and the
 *    v14-shaped Foundry host page at /.
 * Their addresses reach the specs through E2E_* environment variables.
 */

import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, startSfu } from './support/sfu-server.js';
import { startStaticServer } from './support/static-server.js';

/** RTC range of the shared server; the restart spec uses its own range. */
export const SHARED_RTC_PORTS = { min: 40000, max: 40099 } as const;

export default async function globalSetup(): Promise<() => Promise<void>> {
  // E2E_DIST_DIR points the suite at another build of the module (e.g. a
  // deliberately broken copy, to check that the specs can fail).
  const distDir = path.resolve(process.env.E2E_DIST_DIR ?? path.join(REPO_ROOT, 'dist'));
  const manifestPath = path.join(distDir, 'module.json');
  if (!existsSync(manifestPath)) {
    throw new Error('dist/module.json is missing. Run `bun run build` before the e2e suite.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { esmodules?: string[] };
  for (const entry of manifest.esmodules ?? []) {
    if (!existsSync(path.join(distDir, entry))) {
      throw new Error(`dist/${entry} (listed in module.json esmodules) is missing.`);
    }
  }

  const snapshot = path.join(REPO_ROOT, 'test-results/e2e-dist');
  rmSync(snapshot, { recursive: true, force: true });
  cpSync(distDir, snapshot, { recursive: true });

  const token = `e2e-${Math.random().toString(36).slice(2)}`;
  const sfu = await startSfu({
    token,
    rtcMinPort: SHARED_RTC_PORTS.min,
    rtcMaxPort: SHARED_RTC_PORTS.max,
    logName: 'sfu-shared',
  });
  const web = await startStaticServer([
    { prefix: '/modules/mediasoup-vtt/', dir: snapshot },
    { prefix: '/', dir: path.join(REPO_ROOT, 'tests/e2e/sfu/host') },
  ]);

  process.env.E2E_BASE_URL = web.url;
  process.env.E2E_SFU_URL = sfu.url;
  process.env.E2E_SFU_TOKEN = token;
  console.log(
    `[e2e] SFU ${sfu.url} (log ${sfu.logFile}); host page ${web.url}; bundle ${distDir} (snapshot)`,
  );

  return async () => {
    await web.close();
    await sfu.stop();
  };
}
