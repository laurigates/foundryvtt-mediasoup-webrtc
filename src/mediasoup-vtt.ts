/**
 * MediaSoupVTT - main entry point.
 *
 * Replaces Foundry's built-in peer-to-peer A/V with a MediaSoup SFU by
 * registering MediaSoupAVClient as CONFIG.WebRTC.clientClass. Core AVMaster
 * (`game.webrtc`) instantiates that class in Game#initializeRTC, which runs in
 * setupGame after the `init` and `setup` hooks, so assigning it at import time
 * is early enough on v13 and v14.
 */

// mediasoup-client v3 has NO default export (only named/namespace exports:
// Device, detectDevice, version, debug, types, ortc, …).
import * as mediasoupClient from 'mediasoup-client';
import { MediaSoupAVClient } from './client/MediaSoupAVClient.js';
import { MODULE_TITLE } from './constants/index.js';
import { registerSettings } from './ui/settings.js';
import { injectStyles } from './ui/styles.js';
import { log } from './utils/logger.js';

// Exposed for debugging from the browser console.
window.mediasoupClient = mediasoupClient;

// Must be set before AVMaster is constructed (Game#initializeRTC).
CONFIG.WebRTC.clientClass = MediaSoupAVClient;

// Debug alias: always the live AVClient instance owned by AVMaster.
Object.defineProperty(window, 'MediaSoupVTT_Client', {
  configurable: true,
  enumerable: false,
  get: () => (typeof game !== 'undefined' ? game.webrtc?.client : undefined),
});

Hooks.once('init', () => {
  log(
    `Initializing ${MODULE_TITLE} (mediasoup-client ${mediasoupClient.version})...`,
    'info',
    true,
  );
  registerSettings();
  injectStyles();
});

Hooks.once('ready', () => {
  const client = game.webrtc?.client;
  if (client instanceof MediaSoupAVClient) {
    log('MediaSoupAVClient is the active A/V client.', 'info');
  } else {
    log(
      `The active A/V client is ${client?.constructor?.name ?? 'none'}, not MediaSoupAVClient.`,
      'warn',
      true,
    );
  }
});

log('MediaSoupVTT module script loaded.');
