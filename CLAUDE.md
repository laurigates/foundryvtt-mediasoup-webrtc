# MediaSoupVTT (`mediasoup-vtt`)

A FoundryVTT v13 module providing WebRTC audio/video between players via a
**MediaSoup SFU**. Built with Vite + TypeScript + bun + biome. Two parts:

- **Client** (`src/`) — the Foundry ESM module, bundled to `dist/mediasoup-vtt.mjs`.
- **Server** (`server/`) — a standalone Rust MediaSoup SFU the client connects to
  over a WebSocket. Has its own Cargo build/test and CI (`server-ci.yml`).

## Layout

| Path | Role |
|------|------|
| `module.json` | The manifest. `id` = `mediasoup-vtt`, MUST match the install folder + zip name. release-please bumps `$.version` in lockstep with `package.json`. |
| `src/mediasoup-vtt.ts` | ESM entry (`esmodules`). Registers Foundry hooks; built to `dist/mediasoup-vtt.mjs` by Vite. |
| `src/client/MediaSoupVTTClient.ts` | The WebRTC/mediasoup client — WebSocket signaling, transports, producers/consumers. Talks to `server/`. |
| `src/ui/*.ts` | Foundry UI integration (settings, config dialog, scene controls, player list). |
| `src/constants/index.ts` | `MODULE_ID` / settings keys / signaling message types — single source. |
| `src/foundry-shims.d.ts` | Loose ambient types for Foundry globals. Keep `tsc` green; verify the real API before trusting a shape. |
| `lang/en.json`, `styles/mediasoup-vtt.css`, `templates/` | Localization, styles, Handlebars templates — static-copied to `dist/`. |
| `server/` | The Rust SFU (see `server/README.md`). |

## Commands

`just` (or `just --list`) for recipes; underlying scripts are bun:

- `just dev` — Vite dev server (proxies to Foundry on :30000 with HMR).
- `just build` — build `dist/mediasoup-vtt.mjs` + static assets.
- `just check` — **the local gate**: `typecheck` + `build` + `lint` (biome) + `test` (vitest). Must pass before pushing.
- `just server-check` — `cargo fmt --check` + `clippy -D warnings` + `cargo test` for the Rust SFU.
- `just test-e2e` — Playwright integration suite (needs a live Foundry harness; see caveat below).

## Rules of the road

- **`mediasoup-client` is BUNDLED, not external.** Foundry has no npm, so the SFU
  client ships inside `dist/mediasoup-vtt.mjs`. Vite lib-mode bundles it by default
  (do not add it to `rollupOptions.external`). It has **no default export** — import
  it as `import * as mediasoupClient from 'mediasoup-client'`.
- **Target the harness-pinned Foundry version.** The local `foundryvtt-harness`
  pins a specific v13 build; behavior is version-specific. Keep `module.json`
  `compatibility.{minimum,verified}` in sync with what you actually test against.
- **Verify the Foundry API before patching.** `game.*`, hooks, and the
  `foundry.applications.*` namespaces change across major versions. Check
  <https://foundryvtt.com/api/> or the live console — not memory or the shims.
- **ESM only, paths must byte-match the manifest.** `esmodules` references
  `mediasoup-vtt.mjs`; if the Vite output name drifts, the module silently fails to load.
- **Do not commit `dist/`.** It is a build artifact (git-ignored); CI builds it for releases.
- **Green `just check` ≠ working A/V.** The unit/type/build/lint gates cannot
  exercise real-time WebRTC — that needs a live Foundry + a running `server/` SFU.
  Test A/V changes end-to-end against the harness.

## Reference docs (context7)

- `/foundryvtt/foundryvtt`, `/versatica/mediasoup`, `/versatica/mediasoup-client`

## Caveat: the Playwright e2e suite is deferred

`tests/integration/` predates the Vite migration and loaded a Rollup-only test
bundle that no longer exists. The suite is currently **not wired to the Vite
build and not run in CI** (it's excluded from biome too). `just test-e2e` will not
pass until it's re-wired — tracked as a follow-up issue. Unit tests (`tests/unit/`,
Vitest) are the CI test gate.
