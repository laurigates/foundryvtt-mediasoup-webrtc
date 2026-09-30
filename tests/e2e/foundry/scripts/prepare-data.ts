/**
 * Prepare a Foundry data volume for the e2e tier, before Foundry starts.
 *
 *   bun tests/e2e/foundry/scripts/prepare-data.ts \
 *     --data <dir mounted at /data> [--module-out <dir mounted as the module>] \
 *     --foundry-version 14.368 [--dist dist] [--force]
 *
 * 1. Copies the code-free fixture system to <data>/Data/systems/.
 * 2. Copies the fixture world to <data>/Data/worlds/<id>/ with coreVersion and
 *    compatibility.verified set to the build under test, so Foundry launches
 *    it without a migration. An existing world is left alone (it holds the
 *    LevelDB databases of earlier runs) unless --force is given.
 * 3. With --module-out: stages the built module (dist/) there (replacing
 *    that directory), with
 *    compatibility.verified stamped to the build under test. The manifest's
 *    own "verified" is a release claim that is only bumped after this suite
 *    passes (Stage 5A); without the stamp, Foundry could flag the module as
 *    unverified for a newer build and the load spec, which fails on any
 *    warning about the module, could never pass first. Nothing else in dist/
 *    is changed.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, '../../../..');
const FIXTURES = path.resolve(HERE, '../fixtures');

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    'module-out': { type: 'string' },
    'foundry-version': { type: 'string' },
    dist: { type: 'string', default: path.join(REPO_ROOT, 'dist') },
    world: { type: 'string', default: process.env.FOUNDRY_E2E_WORLD || 'mediasoup-e2e' },
    force: { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(`prepare-data: ${message}`);
  process.exit(1);
}

const dataDir = values.data ? path.resolve(values.data) : fail('--data is required');
// Optional: a harness that already mounts dist/ as the module can skip staging.
const moduleOut = values['module-out'] ? path.resolve(values['module-out']) : null;
const version = values['foundry-version'] ?? fail('--foundry-version is required');
if (!/^\d+\.\d+$/.test(version)) fail(`--foundry-version must look like 14.368, got "${version}"`);
const distDir = path.resolve(values.dist);
const worldId = values.world;

type Json = Record<string, any>;
const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8')) as Json;
const writeJson = (file: string, data: Json) =>
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

// 1. The system.
const systemSrc = path.join(FIXTURES, 'systems/mediasoup-e2e-system');
const systemDst = path.join(dataDir, 'Data/systems/mediasoup-e2e-system');
mkdirSync(systemDst, { recursive: true });
cpSync(systemSrc, systemDst, { recursive: true });

// 2. The world.
const worldDst = path.join(dataDir, 'Data/worlds', worldId);
const worldManifest = path.join(worldDst, 'world.json');
if (existsSync(worldManifest) && !values.force) {
  console.log(`prepare-data: world ${worldId} exists, keeping it (${worldManifest})`);
} else {
  if (values.force) rmSync(worldDst, { recursive: true, force: true });
  mkdirSync(worldDst, { recursive: true });
  const world = readJson(path.join(FIXTURES, 'worlds/mediasoup-e2e/world.json'));
  world.id = worldId;
  world.coreVersion = version;
  world.compatibility = { ...world.compatibility, verified: version };
  writeJson(worldManifest, world);
  console.log(`prepare-data: wrote ${worldManifest} (coreVersion ${version})`);
}

// 3. The module.
if (!moduleOut) {
  console.log('prepare-data: no --module-out, not staging the module');
  process.exit(0);
}
const distManifest = path.join(distDir, 'module.json');
if (!existsSync(distManifest)) fail(`${distManifest} is missing: run \`bun run build\` first`);
const manifest = readJson(distManifest);
for (const entry of manifest.esmodules ?? []) {
  if (!existsSync(path.join(distDir, entry))) {
    fail(`dist/${entry} (listed in module.json esmodules) is missing`);
  }
}
rmSync(moduleOut, { recursive: true, force: true });
mkdirSync(path.dirname(moduleOut), { recursive: true });
cpSync(distDir, moduleOut, { recursive: true });
const staged = readJson(path.join(moduleOut, 'module.json'));
const before = staged.compatibility?.verified;
staged.compatibility = { ...staged.compatibility, verified: version };
writeJson(path.join(moduleOut, 'module.json'), staged);
console.log(
  `prepare-data: staged ${manifest.id} ${manifest.version} in ${moduleOut} ` +
    `(compatibility.verified ${before} -> ${version} for this run)`,
);

// The module bind mount (run-foundry.sh) lands in Data/modules/<id>.
mkdirSync(path.join(dataDir, 'Data/modules'), { recursive: true });
