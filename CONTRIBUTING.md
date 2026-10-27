# Contributing to MediaSoupVTT

The repository holds two parts: the Foundry module (`src/`, TypeScript, built
with Vite and bun) and the SFU (`server/`, Rust). The [README](README.md)
explains what the module does; this file covers how to change it.

## Prerequisites

- [bun](https://bun.sh/) for the module: dependencies, build, lint and tests.
- [just](https://github.com/casey/just) for the task recipes (optional; each
  recipe wraps a `bun run` or `cargo` command).
- Rust 1.88 or newer (`rust-version` in `server/Cargo.toml`), with `rustfmt`,
  a C++20 compiler and Python 3 for the mediasoup worker build. See
  [`server/README.md`](server/README.md) for the full list and for builds
  behind a proxy.

```sh
bun install
```

## Recipes

`just` (or `just --list`) prints every recipe. The ones you need most:

| Recipe | What it runs |
|--------|--------------|
| `just dev` | Vite dev server, proxying to Foundry on `:30000` |
| `just build` | `dist/mediasoup-vtt.mjs` plus the static assets |
| `just check` | typecheck + build + lint (biome) + unit tests |
| `just format` | biome auto-format and auto-fix |
| `just server-check` | `cargo fmt --check`, `clippy -D warnings`, `cargo test` |
| `just test-e2e` | builds the bundle and the SFU, then the Playwright SFU e2e suite |

`just check` is the gate before every push. Run `just server-check` as well
when you touch `server/`.

## Tests

The test tiers (unit, server, SFU e2e, Foundry e2e), what each one proves and
how to run it are in [`tests/README.md`](tests/README.md). A green
`just check` runs against test doubles only; real media flow is proven by
the SFU e2e tier and Foundry integration only by the Foundry e2e tier.

## Commits and releases

- Use [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:`, `perf:`; `!` for breaking changes).
  release-please reads them to pick the next version, write `CHANGELOG.md`
  and bump `version` in both `package.json` and `module.json`. Do not edit
  those versions by hand.
- Do not commit `dist/`. It is a build artifact; CI builds it for releases.

## Rules for changes

- **Licensing.** Never copy Foundry core source into the repository, and do
  not copy code from `avclient-livekit` (Hippocratic License 2.1) either.
  Write test doubles and stubs from the public API docs
  (<https://foundryvtt.com/api/>).
- **Signaling contract.** Message types live in `src/constants/index.ts`
  (`SIG_MSG_TYPES`). Each request needs a match arm in `server/src/server.rs`;
  each notification is sent from `server/src/room.rs`. Change both sides in
  the same pull request.
- **Three settings.** The module registers `debugLogging` (client),
  `mediaSoupServerUrl` and `mediaSoupAuthToken` (world), plus the GM-only
  `configDialog` menu. Devices, mute, voice mode and push-to-talk belong to
  core AVSettings; do not add module settings for them.
- **AVClient only.** The module feeds core AVMaster, CameraViews and
  AVSettings through the AVClient API; it adds no media DOM, scene controls
  or player-list video of its own. Dialogs use ApplicationV2.
- **Check the Foundry API** (<https://foundryvtt.com/api/>) before relying on
  a shape; `src/foundry-shims.d.ts` is deliberately loose.

## Further reading

- [`docs/client-architecture.md`](docs/client-architecture.md): the AVClient
  methods the module implements and the events the transport core emits.
- [`docs/blueprint/adrs/`](docs/blueprint/adrs/): architecture decisions,
  for example [ADR-004](docs/blueprint/adrs/ADR-004-foundry-avclient-integration.md)
  on the AVClient integration.
- [`server/README.md`](server/README.md): building, configuring and
  deploying the SFU.
- [`SECURITY.md`](SECURITY.md): report vulnerabilities privately, not in a
  public issue.
