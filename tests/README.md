# Tests

MediaSoupVTT is tested in tiers. Each tier proves something the one below it
cannot, and each one's assertions are written so they fail when the behaviour
breaks: a green run with no media flowing is not possible.

| Tier | Where | Runs | Proves | Needs |
|------|-------|------|--------|-------|
| Unit | `tests/unit/` (Vitest, happy-dom) | `bun run test` (part of `just check`); CI `ci.yml` | Client logic against v14-shaped Foundry test doubles (written from the public API pages; AVSettings, AVMaster and CameraViews reduced to the surface the module uses) and a fake signaling socket: the AVClient contract, signaling payloads, pause/resume, reconnect/ICE recovery, the settings UI | nothing |
| Server | `server/tests/`, `server/src/**` (cargo) | `just server-check`; CI `server-ci.yml` | The Rust SFU's signaling contract end to end over a WebSocket | Rust toolchain |
| SFU e2e | `tests/e2e/sfu/` (Playwright, Chromium) | `just test-e2e` / `bun run test:e2e`; CI `e2e.yml` | The **real bundle** loads and registers on a v14-shaped Foundry, and **real audio and video flow** browser -> SFU -> browser | a built `dist/` and SFU release binary |
| Foundry e2e | `tests/e2e/foundry/` (separate `playwright.foundry.config.ts`) | `bunx playwright test -c playwright.foundry.config.ts` (see `tests/e2e/foundry/README.md`); CI `foundry-e2e.yml`, only when Foundry secrets exist | The module inside a real Foundry v14 server. **Not run yet**: no result from this tier exists so far | a Foundry license |

## SFU e2e tier (`tests/e2e/sfu/`)

### What runs

- `global-setup.ts` checks that `dist/` is built (every `esmodules` entry of
  `dist/module.json` exists), then starts:
  - the real SFU, `server/target/release/mediasoup-server`, on a free
    `127.0.0.1` port, with `MEDIASOUP_LISTEN_IP=MEDIASOUP_ANNOUNCED_IP=127.0.0.1`,
    an auth token and the RTC port range 40000-40099;
  - a static server that serves a snapshot of `dist/` (copied to
    `test-results/e2e-dist/`, so a rebuild during the run cannot swap the
    bundle) at `/modules/mediasoup-vtt/`, the URL Foundry serves an installed
    module from, and the host page at `/`.

  It builds nothing: CI builds both beforehand, and `just test-e2e` builds
  them first. The server's output goes to `test-results/e2e-logs/`.
- `host/index.html` + `host/foundry-stub.js` is a small stand-in for the
  Foundry v14 client, written from the public API documentation
  (foundryvtt.com/api: `foundry.av.AVClient`, `AVMaster`, `AVSettings`,
  `CameraViews`, `ClientSettings`, `Hooks`) and the behaviour the module
  relies on; it contains no Foundry core code. It provides `Hooks`,
  `game.settings` (a `settings` Map; get() throws for unregistered keys),
  `game.user(s)`/`world`/`i18n` (loaded from the module's `lang/en.json`),
  an abstract `foundry.av.AVClient` whose abstract methods throw,
  `AVSettings` (set() persists and reports a diff to AVMaster and the
  client) and an `AVMaster` that connects (`initialize()` + `connect()`),
  applies the voice mode, answers the permission checks and turns
  `broadcast()` into `toggleBroadcast()`. Core's own voice-level analysis and
  push-to-talk key handling are not reproduced: voice detection is a double
  that records which levels stream it would watch, and the specs supply its
  verdict (`__e2e.speak()`) and the key (`__e2e.pushToTalk()`) directly. A
  CameraViews-like `ui.webrtc` renders a `.camera-view[data-user]
  video.user-camera` tile per `getConnectedUsers()` id and calls
  `setUserVideo` on it. The page imports the module's `esmodules` from its
  `module.json`, fires `init`/`i18nInit`/`setup`, creates AVMaster (which
  instantiates `CONFIG.WebRTC.clientClass`), and fires `ready`; the spec
  then calls `AVMaster#connect()`. Probes for the specs are on
  `window.__e2e`.
- Each peer is one Foundry user in its own browser context; each test gets its
  own world id, so its own SFU room. Chromium runs with
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.

### Specs

- `module.spec.ts`: the bundle sets `CONFIG.WebRTC.clientClass` to
  `MediaSoupAVClient` at import time; it extends `foundry.av.AVClient` and
  overrides every abstract method; AVMaster instantiates it; the three
  settings, the config menu and the `renderSettingsConfig` hook are
  registered, and the Settings-page help shows the live connection status.
- Tiles are read as the client left them: no spec forces a CameraViews
  render, so the client must re-render by itself when remote tracks arrive,
  change or go away. A tile check asserts the `<video>` holds the client's
  stream for that user (not the local capture), is playing, its clock
  advances, and its pixels (drawn to a canvas) are neither uniform (black
  frames from a disabled track) nor frozen. Audio checks compare
  `inbound-rtp` `totalAudioEnergy` too: Chromium's fake microphone beeps, and
  a disabled track sends silence at the same packet rate.
- `av.spec.ts`:
  - two users each consume the other's audio and video; the dock tile plays
    the remote stream with a real, moving picture; `inbound-rtp` bytes,
    packets and audio energy grow between two samples, and video frames
    decode; "mute all" re-renders and mutes the remote tile;
  - a late joiner receives a peer that was already producing;
  - mute and hide (through `AVSettings`) disable the local track and pause the
    remote producer: the paused flag reaches the other peer and its packets
    and audio energy stop, while the other kind keeps flowing; unmute and
    show resume them with audible audio and a real picture;
  - a disabled audio source closes the mic producer (the remote consumer goes
    away); re-enabling it gives exactly one new audio consumer;
  - a wrong token fails `connect()` with a notification and no reconnect
    loop; fixing the setting reconnects;
  - closing a peer's page removes its tracks from every other peer.
- `voice.spec.ts`: the broadcast decision is handed to AVMaster directly
  (push-to-talk key, voice-detection verdict, or a voice-mode change through
  `AVSettings`) and the module's response is asserted: its mic producer is
  paused/resumed at the SFU (the other peer sees the paused flag and its
  decoded audio energy stays flat or grows), the local track follows, voice
  detection is re-armed on an enabled levels stream when switching to voice
  activation, and the local speaking indicator is restored after re-arming.
- `reconnect.spec.ts`: a dedicated SFU (RTC ports 40100-40149) is killed
  mid-session and restarted; both clients reconnect by themselves, get fresh
  consumers, and media flows again.

### Running it locally

```sh
bun install
just test-e2e            # builds dist/ and the SFU, then runs the suite
# or, with both already built:
bun run test:e2e
bun run test:e2e:list    # list the specs without running them
bun run test:e2e:report  # open the last HTML report
```

- Browser: Playwright's own Chromium (`bunx playwright install chromium`).
  To use another Chromium binary, e.g. a preinstalled one whose revision
  differs from the one this Playwright version pins, set
  `PW_CHROMIUM_PATH=/path/to/chrome`.
- Other overrides: `E2E_SFU_BINARY` (the server binary) and `E2E_DIST_DIR`
  (the module build; point it at a deliberately broken copy to check that the
  specs catch the break).
- The SFU build needs the mediasoup worker's C++ toolchain; see
  `server/README.md`. When a proxy blocks meson's subproject archive
  downloads, pre-fetch them into one directory and set
  `MESON_PACKAGE_CACHE_DIR` (details in `CLAUDE.md`, "Server build notes").

### Limits

The host page is a stub: it proves the bundle against the v14 API shapes and
the real SFU, not against Foundry itself (its sockets, user activity, the real
CameraViews template). That is the Foundry e2e tier's job.
