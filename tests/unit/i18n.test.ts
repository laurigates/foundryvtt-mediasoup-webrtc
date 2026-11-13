/**
 * lang/en.json against the code: every MEDIASOUPVTT.* key the module uses
 * (src/**\/*.ts and templates/*.html) exists, and every key in en.json is used.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../lang/en.json';

const ROOT = resolve(__dirname, '../..');

/**
 * Keys the code builds at runtime, by the exact template-literal prefix it
 * uses, with every key it can produce. A new dynamic key must be listed here.
 */
const DYNAMIC_KEYS: Record<string, string[]> = {
  // src/ui/settings.ts: `MEDIASOUPVTT.SettingsHelp.${key}` over Step1..Step3.
  'MEDIASOUPVTT.SettingsHelp.${': [
    'MEDIASOUPVTT.SettingsHelp.Step1',
    'MEDIASOUPVTT.SettingsHelp.Step2',
    'MEDIASOUPVTT.SettingsHelp.Step3',
  ],
};

const DYNAMIC_PATTERN = /MEDIASOUPVTT(?:\.[A-Za-z0-9_]+)*\.\$\{/g;
const STATIC_PATTERN = /MEDIASOUPVTT(?:\.[A-Za-z0-9_]+)+/g;
const CORE_PATTERN = /\bWEBRTC(?:\.[A-Za-z0-9_]+)+/g;

function filesUnder(dir: string, extension: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path, extension));
    else if (entry.name.endsWith(extension)) files.push(path);
  }
  return files;
}

/** Every leaf key path of a nested translations object. */
function leafKeys(object: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(object).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object'
      ? leafKeys(value as Record<string, unknown>, path)
      : [path];
  });
}

const sources = [
  ...filesUnder(join(ROOT, 'src'), '.ts'),
  ...filesUnder(join(ROOT, 'templates'), '.html'),
].map((path) => ({ path: path.slice(ROOT.length + 1), text: readFileSync(path, 'utf8') }));

/** key -> files that use it. */
const used = new Map<string, Set<string>>();
const unknownDynamic: string[] = [];
const coreKeys = new Set<string>();
for (const { path, text } of sources) {
  const add = (key: string) => {
    if (!used.has(key)) used.set(key, new Set());
    used.get(key)?.add(path);
  };
  for (const match of text.matchAll(DYNAMIC_PATTERN)) {
    const expanded = DYNAMIC_KEYS[match[0]];
    if (expanded) expanded.forEach(add);
    else unknownDynamic.push(`${path}: ${match[0]}`);
  }
  // Drop the dynamic prefixes so their static part is not read as a key.
  for (const match of text.replace(DYNAMIC_PATTERN, '').matchAll(STATIC_PATTERN)) add(match[0]);
  for (const match of text.matchAll(CORE_PATTERN)) coreKeys.add(match[0]);
}

const defined = new Set(leafKeys(en));

describe('lang/en.json', () => {
  it('the scan finds the keys (sanity)', () => {
    expect(sources.some((s) => s.path.endsWith('.html'))).toBe(true);
    expect(used.size).toBeGreaterThan(20);
  });

  it('every dynamically built key is declared in DYNAMIC_KEYS', () => {
    expect(unknownDynamic).toEqual([]);
  });

  it('defines every MEDIASOUPVTT.* key used in src/ and templates/', () => {
    const missing = [...used.keys()]
      .filter((key) => !defined.has(key))
      .map((key) => `${key} (${[...(used.get(key) ?? [])].join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('has no unused keys', () => {
    expect([...defined].filter((key) => !used.has(key))).toEqual([]);
  });

  it('only defines the module namespace: WEBRTC.* keys come from core', () => {
    expect(Object.keys(en)).toEqual(['MEDIASOUPVTT']);
    // The core keys the module relies on are not redefined by the module.
    for (const key of coreKeys) expect(defined.has(key), key).toBe(false);
  });
});
