---
id: ADR-003
title: Vite + TypeScript Build System
status: accepted
supersedes: ADR-002
created: 2026-07-01
---

# ADR-003: Vite + TypeScript Build System

## Context

[ADR-002](ADR-002-rollup-es-modules-build-system.md) chose Rollup + npm +
JavaScript, with a custom template plugin generating `module.json` and ESLint
for linting. Since then the personal FoundryVTT-module portfolio has
standardised on a common toolchain (see the sibling module
`foundryvtt-render-on-demand` and its `docs/adr/0001-vite-bun-typescript.md`):

- **Vite** library build instead of Rollup.
- **bun** as the package manager and script runner instead of npm.
- **TypeScript** source instead of JavaScript.
- **biome** for lint + format instead of ESLint + Prettier.
- **Vitest** for unit tests.
- A **static, committed `module.json`** (version synced by release-please
  `extra-files`) instead of generating it from a template at build time.

Keeping `mediasoup-webrtc` on the old stack meant it diverged from every other
module — different commands, different CI, no type safety, and a bespoke
template step contributors had to remember.

ADR-002 previously rejected Vite as "adds a dev server that is unnecessary for a
FoundryVTT module workflow." That reasoning no longer holds: Vite's dev server
(with a proxy to the running Foundry instance and HMR) is in fact useful for
module development, and Vite is a thin, well-maintained layer over the same
Rollup core — so nothing is lost on the build side.

## Decision

Adopt the portfolio-standard toolchain:

- **Build**: Vite library mode. Entry `src/mediasoup-vtt.ts`, single ESM output
  `dist/mediasoup-vtt.mjs`. `mediasoup-client` remains **bundled** (Vite lib mode
  bundles dependencies by default; it is not externalised). Static assets
  (`module.json`, `lang/`, `styles/`, `templates/`) are copied via
  `vite-plugin-static-copy`.
- **Package manager / runner**: bun (`bun.lock`).
- **Language**: TypeScript, strict `tsconfig`, with a loose ambient shim
  (`src/foundry-shims.d.ts`) for the Foundry globals. `mediasoup-client` v3 has
  no default export and is imported as a namespace.
- **Lint / format**: biome (2-space standard).
- **Tests**: Vitest unit suite (`tests/unit/`). The pre-existing Playwright
  integration suite is deferred (it depended on a Rollup-only test bundle) and
  is not wired to Vite or CI.
- **Manifest**: a static, committed `module.json`; release-please keeps
  `$.version` in sync via `extra-files`. The `module.json.template` +
  `process-template.cjs` step is removed.
- **Task runner**: a `justfile` (`just check`, `just build`, `just server-check`).

The Rust SFU (`server/`, [ADR-001](ADR-001-mediasoup-sfu-architecture.md)) is
unaffected; it gains a `cargo fmt`/`clippy`/`test` CI job (`server-ci.yml`).

## Consequences

### Positive

- Consistent with every other FoundryVTT module in the portfolio — same
  commands, CI workflows, and conventions.
- Type safety across the client, with the build/typecheck/lint/test gate
  runnable as one `just check`.
- Static `module.json` removes the generate-from-template footgun; contributors
  edit the manifest directly and release-please handles the version bump.
- Vite dev server adds HMR + a Foundry proxy for a smoother dev loop.

### Negative / risks

- Large one-time migration diff (all `src/*.js` → `.ts`, config churn).
- `noUnusedLocals`/`noUncheckedIndexedAccess` strictness required small,
  behaviour-preserving code edits.
- The Playwright integration suite is temporarily broken (deferred) until it is
  re-wired onto the Vite build — tracked as a follow-up issue.
- Green build/type/lint/unit gates do **not** exercise real-time WebRTC A/V;
  that still requires a live Foundry + running SFU.
