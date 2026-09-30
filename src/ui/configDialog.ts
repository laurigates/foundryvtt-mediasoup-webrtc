/**
 * MediaSoup configuration dialog: the server connection settings plus a setup
 * guide. An ApplicationV2 (the V1 FormApplication is deprecated since v13).
 */

import {
  MODULE_ID,
  SETTING_MEDIASOUP_AUTH_TOKEN,
  SETTING_MEDIASOUP_URL,
} from '../constants/index.js';

export const CONFIG_DIALOG_TEMPLATE = `modules/${MODULE_ID}/templates/config-dialog.html`;

/** The fields the dialog's form submits. */
export interface ConfigDialogFormData {
  serverUrl?: string;
  authToken?: string;
}

/** Minimal shape of the FormDataExtended passed to an AppV2 form handler. */
interface FormDataLike {
  object: Record<string, unknown>;
}

/** The part of HandlebarsApplicationMixin(ApplicationV2) this dialog relies on. */
interface HandlebarsAppV2Base {
  new (
    options?: Record<string, unknown>,
  ): {
    readonly id: string;
    _prepareContext(options: unknown): Promise<Record<string, unknown>>;
  };
  DEFAULT_OPTIONS: object;
  PARTS: object;
}

// Resolved when this module is evaluated: Foundry defines `foundry` before it
// imports module scripts.
const { ApplicationV2, HandlebarsApplicationMixin } = (foundry as any).applications.api;
const HandlebarsAppV2 = HandlebarsApplicationMixin(ApplicationV2) as HandlebarsAppV2Base;

export class MediaSoupConfigDialog extends HandlebarsAppV2 {
  static override DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-config-dialog`,
    tag: 'form',
    classes: ['mediasoup-config-dialog'],
    form: {
      handler: MediaSoupConfigDialog.onSubmit,
      closeOnSubmit: true,
    },
    window: {
      title: 'MEDIASOUPVTT.ConfigDialog.Title',
      icon: 'fa-solid fa-server',
      contentClasses: ['standard-form'],
      resizable: true,
    },
    position: {
      width: 700,
      height: 'auto',
    },
  };

  static override PARTS = {
    form: {
      template: CONFIG_DIALOG_TEMPLATE,
      scrollable: [''],
    },
    footer: {
      template: 'templates/generic/form-footer.hbs',
    },
  };

  override async _prepareContext(options: unknown) {
    const context = await super._prepareContext(options);
    const canEdit = game.user?.isGM === true;
    return {
      ...context,
      rootId: this.id,
      serverUrl: (game.settings.get(MODULE_ID, SETTING_MEDIASOUP_URL) as string) || '',
      authToken: (game.settings.get(MODULE_ID, SETTING_MEDIASOUP_AUTH_TOKEN) as string) || '',
      canEdit,
      // World settings: only a GM can save them.
      buttons: canEdit
        ? [
            {
              type: 'submit',
              icon: 'fa-solid fa-floppy-disk',
              label: 'MEDIASOUPVTT.ConfigDialog.Save',
            },
          ]
        : [],
    };
  }

  /**
   * Form submission handler. AppV2 calls it with `this` bound to the dialog
   * and a FormDataExtended whose `object` holds the named inputs.
   */
  static async onSubmit(
    _event: Event,
    _form: HTMLFormElement,
    formData: FormDataLike,
  ): Promise<void> {
    const data = formData.object as ConfigDialogFormData;
    // Disabled inputs (non-GM view) are not submitted: leave those settings be.
    // Only write changed values: each write reconnects every peer.
    if (typeof data.serverUrl === 'string') {
      const serverUrl = data.serverUrl.trim();
      if (serverUrl !== game.settings.get(MODULE_ID, SETTING_MEDIASOUP_URL)) {
        await game.settings.set(MODULE_ID, SETTING_MEDIASOUP_URL, serverUrl);
      }
    }
    if (typeof data.authToken === 'string') {
      if (data.authToken !== game.settings.get(MODULE_ID, SETTING_MEDIASOUP_AUTH_TOKEN)) {
        await game.settings.set(MODULE_ID, SETTING_MEDIASOUP_AUTH_TOKEN, data.authToken);
      }
    }
    ui.notifications.info(game.i18n?.localize('MEDIASOUPVTT.ConfigDialog.Saved') ?? 'Saved');
  }
}
