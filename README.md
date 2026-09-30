# MediaSoupVTT

A FoundryVTT module that carries the core audio/video conference through a
self-hosted [MediaSoup](https://mediasoup.org/) SFU instead of Foundry's
built-in peer-to-peer connections. It has two parts:

- **the module** (`src/`): a Foundry AVClient, bundled with `mediasoup-client`
  into `dist/mediasoup-vtt.mjs`;
- **the server** (`server/`): a Rust SFU built on the `mediasoup` crate. The
  module talks to it over a WebSocket. See [`server/README.md`](server/README.md).

## How it works

The module registers `MediaSoupAVClient` as `CONFIG.WebRTC.clientClass`, so it
replaces core's peer-to-peer client while the module is enabled. Foundry's own
A/V parts keep doing their jobs:

- AVMaster connects and disconnects the client;
- the camera dock (CameraViews) shows the video tiles;
- Configure Audio/Video (AVSettings) holds the devices, mute and hide state,
  the voice mode and the push-to-talk key.

The module adds no scene controls or player-list video of its own. Each
Foundry world joins its own room on the SFU (the room id is the world id), so
one server can serve several worlds.

## Compatibility

- `module.json`: `minimum` 13, `verified` 13.348.
- The client is written against the public v13/v14 API (`foundry.av.AVClient`,
  AVSettings, ApplicationV2). Foundry v14 (14.368) is the target.
- **Not yet verified inside a real Foundry server.** The unit tests and the
  SFU e2e suite run the module against v14-shaped test doubles and a stub
  page. The Foundry e2e job (`foundry-e2e.yml`, 14.368 gating, 13.351
  informational) has not run yet. `verified` is raised only after it passes.
- Browser: a Chromium-based browser or the Foundry desktop app. Other browsers
  that `mediasoup-client` supports may work; they are not tested.

## Server

The SFU needs a TCP port for the WebSocket (default 3000) and a UDP (and TCP)
port range for media (default 10000-10100) reachable from every player.

```sh
cd server
cp .env.example .env    # set MEDIASOUP_ANNOUNCED_IP and MEDIASOUP_AUTH_TOKEN
cargo run --release     # or: docker compose up -d
```

- `MEDIASOUP_ANNOUNCED_IP` is required when the listen IP is `0.0.0.0` (the
  default): it is the address browsers send media to. Without it the server
  refuses to start, unless `MEDIASOUP_ALLOW_UNANNOUNCED=1` is set.
- `MEDIASOUP_AUTH_TOKEN` is the shared secret the module must present. When
  it is unset the server accepts anyone and logs a warning.
- For `wss://`, set `MEDIASOUP_TLS_CERT` and `MEDIASOUP_TLS_KEY`, or put the
  server behind a reverse proxy that terminates TLS.

Building the server needs Rust 1.88 or newer and the mediasoup worker's C++
build dependencies. The full variable list, Docker and reverse-proxy examples
are in [`server/README.md`](server/README.md).

## Installation

On the Foundry Setup screen, open **Add-on Modules**, click **Install
Module** and paste the manifest URL:

```
https://github.com/laurigates/foundryvtt-mediasoup-webrtc/releases/latest/download/module.json
```

For a manual install, unzip
`https://github.com/laurigates/foundryvtt-mediasoup-webrtc/releases/latest/download/mediasoup-vtt.zip`
into `Data/modules/mediasoup-vtt/`. The folder name must be `mediasoup-vtt`.

From source:

```sh
bun install
bun run build           # or: just build
cp -r dist/. /path/to/foundrydata/Data/modules/mediasoup-vtt/
```

## Setup in a world

1. Enable **MediaSoupVTT** in **Manage Modules**.
2. As the GM, set the server connection: in the sidebar **Settings** tab
   (labelled Game Settings in older versions), open **Configure Settings** and then
   the MediaSoupVTT section, or use its **Configure MediaSoup Server** menu.
3. Open **Configure Audio/Video** and set the conference mode to Audio/Video,
   Audio Only or Video Only. MediaSoup is used automatically; there is no
   separate mode to pick.
4. Each user chooses their microphone, camera, voice mode and push-to-talk
   key in **Configure Audio/Video** as usual.

## Settings

| Setting | Key | Scope | Notes |
|---------|-----|-------|-------|
| MediaSoup Server WebSocket URL | `mediaSoupServerUrl` | world | `ws://` or `wss://`. Changing it reconnects every connected user. |
| MediaSoup Server Auth Token | `mediaSoupAuthToken` | world | The server's `MEDIASOUP_AUTH_TOKEN`. Changing it reconnects every connected user. |
| MediaSoupVTT Debug Logging | `debugLogging` | client | Verbose console logging. |

The configuration menu (GM only) edits the URL and token in one dialog. The
module's section on the Settings page shows the connection status.

The token is a world setting, so every user in the world can read it. It
keeps strangers off the server; it does not separate users of the same world.

## Troubleshooting

- **No connection:** check the URL, the token, and that TCP 3000 (or your
  `MEDIASOUP_LISTEN_ADDR` port) is reachable. With **Debug Logging** on, the
  browser console shows each signaling step.
- **Connected but no audio or video:** usually the announced IP or the RTC
  port range. `MEDIASOUP_ANNOUNCED_IP` must be an address the players can
  reach, and the RTC ports must be open (UDP, and TCP for the fallback).
- **The dock shows no tiles:** check that the conference mode in Configure
  Audio/Video is not Disabled and that the browser has camera and microphone
  permission.

## Development

```sh
bun install
just dev             # Vite dev server, proxies to Foundry on :30000
just check           # typecheck + build + lint + unit tests (the local gate)
just server-check    # cargo fmt --check, clippy -D warnings, cargo test
```

## Tests

| Tier | Command | CI | Needs |
|------|---------|----|-------|
| Unit (`tests/unit/`, Vitest) | `bun run test` | `ci.yml` | nothing |
| Server (`server/tests/`, cargo) | `just server-check` | `server-ci.yml` | Rust toolchain |
| SFU e2e (`tests/e2e/sfu/`, Playwright) | `just test-e2e`, or `bun run test:e2e` with both built | `e2e.yml` | built `dist/` and the SFU release binary |
| Foundry e2e (`tests/e2e/foundry/`, Playwright) | `tests/e2e/foundry/scripts/run-foundry.sh start`, then `bunx playwright test -c playwright.foundry.config.ts` | `foundry-e2e.yml`, only when the Foundry secrets exist | a Foundry license |

The Foundry e2e tier has not run against a real Foundry server yet. A skipped
`foundry-e2e.yml` run (no secrets) is not a pass.

`PW_CHROMIUM_PATH` points either Playwright tier at another Chromium binary.
Details: [`tests/README.md`](tests/README.md) and
[`tests/e2e/foundry/README.md`](tests/e2e/foundry/README.md).

## Not implemented

Server-side recording of the audio streams is a project goal (see
`REQUIREMENTS.md`) but is not implemented yet.

## License

MIT. See [LICENSE](LICENSE).
