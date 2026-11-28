# MediaSoupVTT (`mediasoup-vtt`)

A FoundryVTT module that replaces core's peer-to-peer A/V with a **MediaSoup
SFU**. It targets v14 (14.368) and keeps v13 as the minimum. Built with Vite +
TypeScript + bun + biome. Two parts:

- **Client** (`src/`) — the Foundry ESM module, bundled to `dist/mediasoup-vtt.mjs`.
- **Server** (`server/`) — a standalone Rust MediaSoup SFU the client connects to
  over a WebSocket. Has its own Cargo build/test and CI (`server-ci.yml`).

## Layout

| Path | Role |
|------|------|
| `module.json` | The manifest. `id` = `mediasoup-vtt`, MUST match the install folder + zip name. release-please bumps `$.version` in lockstep with `package.json`. |
| `src/mediasoup-vtt.ts` | ESM entry (`esmodules`). Sets `CONFIG.WebRTC.clientClass` at import time, registers settings in `init`. Built to `dist/mediasoup-vtt.mjs` by Vite. |
| `src/client/MediaSoupAVClient.ts` | The Foundry AVClient (`extends foundry.av.AVClient`). Maps AVMaster / AVSettings / CameraViews onto the transport core. |
| `src/client/MediaSoupVTTClient.ts` | DOM-free transport core — WebSocket signaling, device, transports, producers/consumers, reconnect, ICE restart. Emits events. Talks to `server/`. |
| `src/ui/*.ts` | Settings registration, the AppV2 config dialog, the `renderSettingsConfig` help block, injected styles. |
| `src/constants/index.ts` | `MODULE_ID` / settings keys / signaling message types — single source. |
| `src/foundry-shims.d.ts` | Loose ambient types for Foundry globals. Keep `tsc` green; verify the real API before trusting a shape. |
| `lang/en.json`, `styles/mediasoup-vtt.css`, `templates/` | Localization, styles, Handlebars templates — static-copied to `dist/`. |
| `tests/` | Unit and e2e tiers — see `tests/README.md`. |
| `server/` | The Rust SFU (see `server/README.md`). |

The module registers exactly three settings — `debugLogging` (client),
`mediaSoupServerUrl` and `mediaSoupAuthToken` (world) — plus the restricted
`configDialog` menu. Devices, mute, voice mode and push-to-talk belong to core
AVSettings; do not add module settings for them.

## Commands

`just` (or `just --list`) for recipes; underlying scripts are bun:

- `just dev` — Vite dev server (proxies to Foundry on :30000 with HMR).
- `just build` — build `dist/mediasoup-vtt.mjs` + static assets.
- `just check` — **the local gate**: `typecheck` + `build` + `lint` (biome) + `test` (vitest). Must pass before pushing.
- `just server-check` — `cargo fmt --check` + `clippy -D warnings` + `cargo test` for the Rust SFU.

## Test tiers

| Tier | Command | CI |
|------|---------|----|
| Unit (`tests/unit/`, Vitest + happy-dom, v14-shaped test doubles) | `bun run test` | `ci.yml` |
| SFU e2e (`tests/e2e/sfu/`, Playwright: real bundle on a Foundry stub page, real SFU, fake devices) | `just test-e2e` (builds first), or `bun run test:e2e` with `dist/` and `server/target/release/mediasoup-server` already built | `e2e.yml`, every PR |
| Foundry e2e (`tests/e2e/foundry/`, Playwright against a real felddy/foundryvtt server) | `bunx playwright test -c playwright.foundry.config.ts` after `tests/e2e/foundry/scripts/run-foundry.sh start` | `foundry-e2e.yml`, only when `FOUNDRY_USERNAME`/`FOUNDRY_PASSWORD` (optionally `FOUNDRY_LICENSE_KEY`, `FOUNDRY_ADMIN_KEY`) secrets exist; otherwise skipped with a warning |

The Foundry e2e tier **has never run against real Foundry yet**. Until
`foundry-e2e.yml` has a green 14.368 run, nothing proves the module works on
v14, and `module.json` `compatibility.verified` stays where it is. A skipped
run is not a pass.

`PW_CHROMIUM_PATH=/path/to/chrome` makes both Playwright tiers use another
Chromium (e.g. `/opt/pw-browsers/chromium-*/chrome-linux/chrome` when its
revision differs from the one Playwright pins).

## Rules of the road

- **The module is an AVClient.** `MediaSoupAVClient` is registered as
  `CONFIG.WebRTC.clientClass` at import time, before `Game#initializeRTC`
  constructs AVMaster. Core owns the lifecycle and the UI (AVMaster,
  CameraViews, AVSettings). Do not add scene controls, player-list video or
  DOM for media — feed core through the AVClient API instead.
- **ApplicationV2 only.** Dialogs use `HandlebarsApplicationMixin(ApplicationV2)`.
  `FormApplication` / `Application` (V1) are deprecated since v13.
- **Render hooks receive an `HTMLElement`, not jQuery.** Use DOM APIs
  (`querySelector`, `append`); no `html.find`, no `html[0]`. Handlers must be
  idempotent (a hook can fire again on the same element).
- **Never copy Foundry core source into the repo.** The Foundry license allows
  only what is strictly necessary for the package. Test doubles and the SFU
  stub page are written from the public API docs (<https://foundryvtt.com/api/>),
  not from core code. The same goes for `avclient-livekit`, the reference
  AVClient module: it is under the Hippocratic License 2.1, so read it for
  the pattern, do not copy its code.
- **`mediasoup-client` is BUNDLED, not external.** Foundry has no npm, so the SFU
  client ships inside `dist/mediasoup-vtt.mjs`. Vite lib-mode bundles it by default
  (do not add it to `rollupOptions.external`). It has **no default export** — import
  it as `import * as mediasoupClient from 'mediasoup-client'`.
- **`verified` follows the Foundry e2e run.** Raise `module.json`
  `compatibility.verified` only to a build with a green `foundry-e2e.yml`
  leg (the current 13.348 predates that tier), and keep `minimum` at 13 only
  while the 13.351 leg passes. The local
  `foundryvtt-harness` pins its own felddy build (13.348 unless changed).
- **Verify the Foundry API before patching.** `game.*`, hooks, and the
  `foundry.applications.*` / `foundry.av.*` namespaces change across major
  versions. Check <https://foundryvtt.com/api/> or the live console — not
  memory or the shims.
- **Keep the signaling contract in sync.** Message types live in
  `src/constants/index.ts`; each request has a match arm in
  `server/src/server.rs`, each notification is sent from `server/src/room.rs`.
- **ESM only, paths must byte-match the manifest.** `esmodules` references
  `mediasoup-vtt.mjs`; if the Vite output name drifts, the module silently fails to load.
- **Do not commit `dist/`.** It is a build artifact (git-ignored); CI builds it for releases.
- **Green `just check` ≠ working A/V.** Unit tests use doubles. Real media flow
  is proven by the SFU e2e tier, and Foundry integration only by the Foundry
  e2e tier.

## Server build notes

- MSRV is **Rust 1.88** (edition 2024).
- `mediasoup-sys` builds the C++ worker with meson, which downloads its
  subprojects (libuv, openssl, abseil, ...) as archives, some from GitHub.
  Proxies that block archive downloads break the build. Workaround: fetch the
  `source_url` / `patch_url` files listed in the crate's
  `subprojects/*.wrap` some other way, put them in one directory under their
  `source_filename` / `patch_filename`, and `export MESON_PACKAGE_CACHE_DIR=<dir>`
  before `cargo build`.
- If the worker cannot be built at all, lint without it:
  `cd server && cargo fmt --check && DOCS_RS=1 cargo clippy --all-targets -- -D warnings`
  (`DOCS_RS` makes `mediasoup-sys` skip the worker build). This cannot link,
  so `cargo test` and the e2e tiers must then run in CI.

## Reference docs (context7)

- `/foundryvtt/foundryvtt`, `/versatica/mediasoup`, `/versatica/mediasoup-client`
