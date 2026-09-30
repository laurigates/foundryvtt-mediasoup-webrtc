// Vitest setup: runs before each unit test file (tests/unit/**), in a fresh
// happy-dom environment, before the file imports anything from src/.
//
// It installs the v14-shaped Foundry globals (game, ui, Hooks, CONFIG,
// foundry) and the browser media fakes. src/client/MediaSoupAVClient.ts reads
// `foundry.av.AVClient` when it is evaluated, so these must exist first.

import { vi } from 'vitest';
import { installFoundryV14 } from './unit/helpers/foundry-v14';
import { installMediaFakes } from './unit/helpers/media';

installFoundryV14();
installMediaFakes();

// The module logs every state change; keep the test output readable. Tests
// that assert on logging spy on console themselves.
for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
  vi.spyOn(console, level).mockImplementation(() => {});
}
