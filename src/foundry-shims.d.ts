// Loose ambient types for the Foundry VTT client globals this module touches.
// These are intentionally permissive (`any`-heavy) — just enough to keep `tsc`
// green. Verify the real Foundry API before trusting any shape here:
// https://foundryvtt.com/api/  (or the live browser console). See CLAUDE.md.

// biome-ignore-all lint: ambient declarations, not runtime code.

interface FoundrySettings {
  register(namespace: string, key: string, data: Record<string, unknown>): void;
  registerMenu(namespace: string, key: string, data: Record<string, unknown>): void;
  get(namespace: string, key: string): any;
  set(namespace: string, key: string, value: unknown): Promise<unknown>;
  // The registered-settings registry: `game.settings.settings.get("<ns>.<key>")`
  // returns the setting config object (whose `.choices` this module mutates).
  settings: Map<string, any>;
}

interface FoundryGame {
  settings: FoundrySettings;
  modules: Map<string, any> & { get(id: string): any };
  user?: any;
  users?: any;
  i18n?: {
    localize(key: string): string;
    format(key: string, data?: Record<string, unknown>): string;
  };
  [key: string]: any;
}

interface FoundryNotifications {
  info(message: string, options?: Record<string, unknown>): void;
  warn(message: string, options?: Record<string, unknown>): void;
  error(message: string, options?: Record<string, unknown>): void;
  notify(message: string, type?: string, options?: Record<string, unknown>): void;
}

interface FoundryUI {
  notifications: FoundryNotifications;
  players?: any;
  controls?: any;
  [key: string]: any;
}

interface FoundryHooks {
  on(hook: string, fn: (...args: any[]) => any): number;
  once(hook: string, fn: (...args: any[]) => any): number;
  off(hook: string, fn: number | ((...args: any[]) => any)): void;
  call(hook: string, ...args: any[]): boolean;
  callAll(hook: string, ...args: any[]): boolean;
}

declare global {
  const game: FoundryGame;
  const ui: FoundryUI;
  const Hooks: FoundryHooks;
  const CONFIG: Record<string, any>;
  // Foundry application base classes (v1 + v2 namespaces). Loose on purpose.
  const FormApplication: any;
  const Application: any;
  const Dialog: any;
  const foundry: Record<string, any>;

  interface Window {
    mediasoupClient?: any;
    MediaSoupVTT_Client?: any;
  }
}

export {};
