/**
 * Record everything a Foundry page logs, from before its first navigation,
 * and classify it: is it a problem, is it this module's, is it a deprecation.
 */

import type { Page } from '@playwright/test';
import { MODULE_ID } from './env.js';

export interface ConsoleEntry {
  /** console.* type ('log', 'info', 'warning', 'error', ...) or 'pageerror'. */
  type: string;
  text: string;
  /** Script or resource URL the message is attributed to, when known. */
  url: string;
}

/** Start recording; the returned array keeps filling for the page's lifetime. */
export function captureConsole(page: Page): ConsoleEntry[] {
  const entries: ConsoleEntry[] = [];
  page.on('console', (msg) => {
    entries.push({ type: msg.type(), text: msg.text(), url: msg.location()?.url ?? '' });
  });
  page.on('pageerror', (error) => {
    entries.push({
      type: 'pageerror',
      text: `${error.name}: ${error.message}\n${error.stack ?? ''}`,
      url: '',
    });
  });
  return entries;
}

/** Warnings, errors and uncaught exceptions. */
export function isProblem(entry: ConsoleEntry): boolean {
  return entry.type === 'warning' || entry.type === 'error' || entry.type === 'pageerror';
}

/**
 * Raised by, or about, this module: its log prefix ("MediaSoupVTT |"), its
 * id, a stack frame in modules/mediasoup-vtt/, or a failed request for one of
 * its files (Chromium attributes "Failed to load resource" to that URL).
 */
export function isFromModule(entry: ConsoleEntry): boolean {
  return /mediasoup/i.test(entry.text) || entry.url.includes(`/modules/${MODULE_ID}/`);
}

/** Foundry's logCompatibilityWarning output and similar notices. */
export function isDeprecation(entry: ConsoleEntry): boolean {
  return /deprecat|backwards-compatible support|will be removed in version|is namespaced under/i.test(
    entry.text,
  );
}

/** Compact form for assertion messages and attachments. */
export function describe(entries: ConsoleEntry[]): string[] {
  return entries.map((e) => `[${e.type}] ${e.text.split('\n').slice(0, 6).join(' | ')}`);
}
