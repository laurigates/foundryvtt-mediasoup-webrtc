/**
 * The configuration dialog as a v14 ApplicationV2 with HandlebarsApplicationMixin.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_DIALOG_TEMPLATE, MediaSoupConfigDialog } from '../../../src/ui/configDialog';
import { registerSettings } from '../../../src/ui/settings';
import { ApplicationV2, foundryEnv, getProperty } from '../helpers/foundry-v14';

const env = foundryEnv();
const en = env.i18n.translations;
const templatePath = resolve(__dirname, '../../../templates/config-dialog.html');

beforeAll(() => {
  registerSettings();
});

beforeEach(async () => {
  env.game.user.isGM = true;
  env.settings.values.clear();
  env.notifications.info.mockClear();
});

describe('class shape', () => {
  it('is an ApplicationV2 built with HandlebarsApplicationMixin, not a v1 FormApplication', () => {
    expect(MediaSoupConfigDialog.prototype).toBeInstanceOf(ApplicationV2);
    expect((MediaSoupConfigDialog as any).HANDLEBARS_MIXIN).toBe(true);
  });

  it('declares DEFAULT_OPTIONS for an AppV2 form', () => {
    const options = MediaSoupConfigDialog.DEFAULT_OPTIONS as Record<string, any>;
    expect(options).toMatchObject({
      id: 'mediasoup-vtt-config-dialog',
      tag: 'form',
      form: { closeOnSubmit: true },
      window: { title: 'MEDIASOUPVTT.ConfigDialog.Title', resizable: true },
      position: { width: 700 },
    });
    expect(options.form.handler).toBe(MediaSoupConfigDialog.onSubmit);
    expect(typeof getProperty(en, options.window.title)).toBe('string');
  });

  it('declares a form PART on the module template, and that template ships', () => {
    const parts = MediaSoupConfigDialog.PARTS as Record<string, any>;
    expect(parts.form.template).toBe('modules/mediasoup-vtt/templates/config-dialog.html');
    expect(CONFIG_DIALOG_TEMPLATE).toBe(parts.form.template);
    expect(parts.footer.template).toBe('templates/generic/form-footer.hbs');
    expect(readFileSync(templatePath, 'utf8').length).toBeGreaterThan(0);
  });

  it('merges its options over the ApplicationV2 defaults', () => {
    const dialog = new MediaSoupConfigDialog();
    expect(dialog.id).toBe('mediasoup-vtt-config-dialog');
    expect((dialog as any).options.tag).toBe('form');
    expect((dialog as any).options.window.minimizable).toBe(true); // from ApplicationV2
    expect((dialog as any).title).toBe(en.MEDIASOUPVTT.ConfigDialog.Title);
  });
});

describe('template', () => {
  const template = readFileSync(templatePath, 'utf8');

  it('has no outer <form>: the application element itself is the form (tag: "form")', () => {
    expect(template).not.toMatch(/<form[\s>]/i);
  });

  it('names its inputs after the fields the submit handler reads', () => {
    const names = [...template.matchAll(/name="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(['authToken', 'serverUrl']);
  });

  it('only uses localization keys that exist in lang/en.json', () => {
    const keys = [...template.matchAll(/localize "([^"]+)"/g)].map((m) => m[1] as string);
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) expect(typeof getProperty(en, key), key).toBe('string');
  });
});

describe('context and submit', () => {
  it('prepares the stored values and a save button for a GM', async () => {
    await env.settings.set('mediasoup-vtt', 'mediaSoupServerUrl', 'wss://sfu.example:4443');
    await env.settings.set('mediasoup-vtt', 'mediaSoupAuthToken', 'tok');
    const dialog = new MediaSoupConfigDialog();
    const context = await dialog._prepareContext({});
    expect(context).toMatchObject({
      rootId: 'mediasoup-vtt-config-dialog',
      serverUrl: 'wss://sfu.example:4443',
      authToken: 'tok',
      canEdit: true,
    });
    expect(context.buttons).toEqual([expect.objectContaining({ type: 'submit' })]);
  });

  it('offers no save button to a player', async () => {
    env.game.user.isGM = false;
    const context = await new MediaSoupConfigDialog()._prepareContext({});
    expect(context.canEdit).toBe(false);
    expect(context.buttons).toEqual([]);
  });

  it('fires render hooks with an HTMLElement', async () => {
    const hook = vi.fn();
    const id = env.hooks.on('renderMediaSoupConfigDialog', hook);
    const generic = vi.fn();
    const genericId = env.hooks.on('renderApplicationV2', generic);
    const dialog = new MediaSoupConfigDialog();
    await (dialog as any).render({ force: true });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0]).toBe(dialog);
    expect(hook.mock.calls[0]?.[1]).toBeInstanceOf(HTMLElement);
    const element = hook.mock.calls[0]?.[1] as HTMLElement | undefined;
    expect(element?.tagName).toBe('FORM');
    expect(generic).toHaveBeenCalledTimes(1);
    env.hooks.off('renderMediaSoupConfigDialog', id);
    env.hooks.off('renderApplicationV2', genericId);
  });

  it('saves only changed, trimmed values and closes', async () => {
    await env.settings.set('mediasoup-vtt', 'mediaSoupAuthToken', 'same');
    const setSpy = vi.spyOn(env.settings, 'set');
    const dialog = new MediaSoupConfigDialog();
    await (dialog as any).submit({ serverUrl: '  wss://new.example  ', authToken: 'same' });
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith('mediasoup-vtt', 'mediaSoupServerUrl', 'wss://new.example');
    expect(env.settings.get('mediasoup-vtt', 'mediaSoupServerUrl')).toBe('wss://new.example');
    expect((dialog as any).closed).toBe(true);
    expect(env.notifications.info).toHaveBeenCalledWith(en.MEDIASOUPVTT.ConfigDialog.Saved);
    setSpy.mockRestore();
  });

  it('leaves settings alone when the inputs were disabled (not submitted)', async () => {
    const setSpy = vi.spyOn(env.settings, 'set');
    await (new MediaSoupConfigDialog() as any).submit({});
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });
});
