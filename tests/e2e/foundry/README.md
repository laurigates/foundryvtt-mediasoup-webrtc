# Foundry e2e tier (`tests/e2e/foundry/`)

The module inside a **real Foundry VTT server**, with the real Rust SFU and
Chromium's fake camera and microphone. The SFU tier (`tests/e2e/sfu/`) runs the
bundle on a Foundry *stub*. This tier checks the parts only real Foundry can:

- the manifest installs;
- core's own boot order registers the client;
- AVMaster connects it;
- core CameraViews renders the dock;
- the AppV2 dialogs render against core's real templates and CSS.

It needs a Foundry license, so CI runs it only when the repository secrets
exist.

```sh
bunx playwright test -c playwright.foundry.config.ts          # run
bunx playwright test -c playwright.foundry.config.ts --list   # list the specs
```

## What runs

1. **`scripts/run-foundry.sh start`** starts Foundry. It is used both by CI and
   by local runs with Docker.
   - **`scripts/prepare-data.ts`** prepares the data directory. It writes:
     - the code-free fixture system `mediasoup-e2e-system` to `Data/systems/`;
     - the fixture world `mediasoup-e2e` to `Data/worlds/`, with
       `coreVersion` set to the build under test so there is no migration.
   - It stages `dist/` with `compatibility.verified` stamped to that build.
     This is the only change to the bundle. `module.json`'s own `verified` is
     a release claim, raised only after this suite passes (Stage 5A).
     Without the stamp, Foundry could flag the module as unverified, and the
     load spec could never pass for the first time.
   - It then runs `ghcr.io/felddy/foundryvtt:<version>` as follows:
     - `--user $(id -u):$(id -g)`;
     - `/data` bind-mounted;
     - the staged module mounted read-only at `/data/Data/modules/mediasoup-vtt`;
     - `FOUNDRY_WORLD=mediasoup-e2e`, `FOUNDRY_TELEMETRY=false`, and
       `CONTAINER_CACHE=/cache`.
   - Finally it waits for `:30000`. It publishes on `127.0.0.1` only.
2. **`global-setup.ts`** runs next.
   1. It waits for Foundry.
   2. It starts the SFU on `127.0.0.1`, with RTC ports 40200-40299, a random
      token, and `MEDIASOUP_ANNOUNCED_IP=127.0.0.1`. It reuses
      `tests/e2e/sfu/support/sfu-server.ts`. The browsers run on the host, so
      only the web server is containerized.
   3. **`support/foundry-session.ts`** walks whatever pre-game screens
      appear:
      - `/license`: license-key activation and/or the EULA. felddy installs
        the key, but a fresh volume still needs the EULA signed in a browser.
      - `/auth`: admin login with `FOUNDRY_ADMIN_KEY`.
      - `/setup`: declines the usage-data prompt, hides tours, then launches
        the world. It clicks the world tile's `worldLaunch` button, or falls
        back to `POST /setup {action: "launchWorld"}`.
      - `/players`: the v14 first-launch user-management gate ("Save and
        Continue").
      - `/join`: `select[name=userid]` before 14.366, or the
        `#join-username` text input from 14.366.
   4. It logs in as the `Gamemaster` user, then:
      - enables the module through `core.moduleConfiguration`;
      - sets `core.rtcWorldSettings.mode` to `AUDIO_VIDEO`;
      - creates the TRUSTED user `E2E Player`. Core grants
        `BROADCAST_AUDIO`/`BROADCAST_VIDEO` to TRUSTED by default.
   5. It reloads, then saves the SFU URL and token in the module's world
      settings. Every step is idempotent.
   6. It writes the ids and URLs to `test-results/foundry-e2e/state.json`.
3. **Specs.** Each test logs its users in from fresh browser contexts.
   Console recording starts before the first navigation. Page-side code only
   uses public API (`game`, `foundry.*`, `CONFIG`, `ui`), so the probes cannot
   trigger deprecation warnings themselves.

## Specs

### `module.spec.ts`

- **Build and module.** The server runs the requested build
  (`game.release.version === FOUNDRY_VERSION`), in the fixture world, and
  `game.modules.get('mediasoup-vtt').active` is true. `esmodules` is
  `['mediasoup-vtt.mjs']`.
- **Client class.**
  - `CONFIG.WebRTC.clientClass.name === 'MediaSoupAVClient'`. It extends
    `foundry.av.AVClient` and is not core's `SimplePeerAVClient`.
  - `game.webrtc.client instanceof` it, and `window.MediaSoupVTT_Client`
    aliases it.
  - A/V mode is Audio & Video, and core connected it to the SFU with local
    audio and video captured.
- **Settings.** Exactly the three settings are registered, with their scope,
  config flag and type: `debugLogging` (client), and `mediaSoupServerUrl` and
  `mediaSoupAuthToken` (world). The `configDialog` menu is registered and
  restricted. The saved URL made the round trip through the server.
- **Clean load.** Nothing the module logs or causes during load is a problem.
  - It fails on any warning, error or uncaught exception that mentions
    MediaSoup, carries the module's log prefix, or points at
    `modules/mediasoup-vtt/`.
  - It fails on any deprecation warning. Set
    `FOUNDRY_E2E_ALLOW_CORE_DEPRECATIONS=1` to allow the ones that do not
    come from the module.
  - To show the recorder works, the module's `init` and `ready` log lines
    must be captured. So must core's own `Connected to the MediaSoupAVClient
    Audio/Video client`.
- **Config dialog.** The configuration menu opens an **ApplicationV2**
  `<form>` with a localized title. It shows the saved server URL and token
  from `modules/mediasoup-vtt/templates/`, has a save button, and closes.
- **Settings page.** On the real `SettingsConfig`, the `renderSettingsConfig`
  hook injects the help block:
  - exactly once, and still once after a re-render;
  - inside the section that holds the module's own fields;
  - localized, with the status `connected`.

### `av.spec.ts`

- **Media flows both ways.** The GM and the player connect, with the voice
  mode set to "always" through core AVSettings.
  - The player may broadcast, and produces unpaused audio and video.
  - The GM consumes both tracks. Core's dock on the GM's screen shows the
    player's `<video>`:
    - its source is the client's remote stream, not the local capture;
    - it has live audio and video tracks, `videoWidth`/`videoHeight > 0`, and
      `readyState >= 2`;
    - it is playing, not hidden and not muted, and its `currentTime`
      advances.
  - `inbound-rtp` bytes and packets grow for both kinds on the same
    consumers, and video frames decode.
  - The same checks pass the other way round.
- **Leaving.** When the player's browser closes, the GM closes the player's
  consumers, and the player drops out of `getConnectedUsers()`.

## CI (`.github/workflows/foundry-e2e.yml`)

- **`preflight`** outputs `has_secrets=true` only when both
  `FOUNDRY_USERNAME` and `FOUNDRY_PASSWORD` are set and the event is not a
  pull request from a fork. The `foundry` job is skipped otherwise, which
  counts as passing: forks, Dependabot and repos without the secrets stay
  green. The skip is not silent: preflight writes a "Foundry e2e SKIPPED"
  warning annotation and job summary. A skipped run is not evidence that the
  module works on v14.
- **Triggers:** push to `main` and pull requests to `main` that touch the
  module, the SFU, the e2e suite or the build (see the workflow's `paths`),
  and `workflow_dispatch`.
- **Matrix.**
  - `14.368` gates the result.
  - `13.351` runs with `continue-on-error`. Keep `module.json` `minimum: "13"`
    only while it passes.
  - The legs run one at a time (`max-parallel: 1`), and the `foundry` job
    (not preflight) shares one concurrency group across runs, because one
    license runs one server. A skip-only run never enters the group.
- **Job steps:**
  1. build the SFU (release), `bun run build`, and install Playwright's
     Chromium;
  2. start Foundry with `run-foundry.sh`;
  3. run `bunx playwright test -c playwright.foundry.config.ts`;
  4. print the container log to the masked job log;
  5. on failure or cancellation (timeout), upload `test-results/foundry-e2e/`
     and the SFU log. The data directory is never uploaded, because it holds
     `Config/license.json`. The suite stops at its `globalTimeout` (35 min)
     before the job's 75-minute limit, so the report is always written.
- **Secrets in artifacts.** Only global setup, which Playwright does not
  trace, may type the license key or the admin key. Test contexts (traced on
  failure) refuse to, so the uploaded traces hold neither.

### Repository secrets and variables

| Name | Kind | Required | Purpose |
|------|------|----------|---------|
| `FOUNDRY_USERNAME` | secret | yes | foundryvtt.com account (felddy downloads the release and, without a key, fetches the license) |
| `FOUNDRY_PASSWORD` | secret | yes | its password |
| `FOUNDRY_LICENSE_KEY` | secret | no | the license key to install. If unset, felddy uses the account's license. |
| `FOUNDRY_ADMIN_KEY` | secret | no | Setup-screen admin password. If unset, a random one is generated per run. |
| `FOUNDRY_E2E_CACHE` | variable | no | `true` caches the Foundry release archive with `actions/cache` |

**Caching is off by default.** The cached archive is the licensed Foundry
distribution. A pull request's workflow run can restore caches that the
default branch created, and a fork's pull request controls its own workflow
file. Enable the cache only if outside pull requests always need approval
before their workflows run. Without the cache, each run downloads the
release, about 200 MB.

## Running it locally

### With Docker and a Foundry account

```sh
bun install && bun run build
(cd server && cargo build --release)       # export MESON_PACKAGE_CACHE_DIR first if offline
export FOUNDRY_USERNAME=... FOUNDRY_PASSWORD=... FOUNDRY_ADMIN_KEY=choose-one
export FOUNDRY_VERSION=14.368               # the image tag, and the build the specs expect
tests/e2e/foundry/scripts/run-foundry.sh start
bunx playwright test -c playwright.foundry.config.ts
tests/e2e/foundry/scripts/run-foundry.sh stop
```

The data directory defaults to `test-results/foundry-data/`. The release cache
is `~/.cache/mediasoup-vtt-foundry/`. The data is kept between runs, and
provisioning is idempotent. To start clean, delete the data directory, or run
`prepare-data.ts --force`. On a new host port (`FOUNDRY_E2E_PORT`), set
`FOUNDRY_URL=http://127.0.0.1:<port>` too.

### Against the local foundryvtt-harness

The harness at `../foundryvtt-dev/foundryvtt-harness/` is local-only. It
serves Foundry on `:30000` with docker compose, and its `data/` holds the
**only copy** of a dated production world. **Back it up before changing
anything.**

1. **Pin the harness to v14.** In the harness's compose file, change the
   felddy image tag from `13.348` to `14.368`. Then run
   `docker compose pull && docker compose up -d && make health-check`. The
   first v14 start migrates the worlds it opens, which is one more reason to
   back up first.
2. **Add the fixture world and system.** This only adds directories; nothing
   existing is touched:

   ```sh
   bun tests/e2e/foundry/scripts/prepare-data.ts \
     --data ../foundryvtt-dev/foundryvtt-harness/data --foundry-version 14.368
   ```

   Leave out `--module-out` if the harness already serves this repo's `dist/`
   as `Data/modules/mediasoup-vtt`. That directory is replaced when
   `--module-out` is given. Without the stamp, the load spec can fail on an
   "unverified" notice until `module.json` is bumped.
3. **Return the harness to the Setup screen,** or restart it with
   `FOUNDRY_WORLD=mediasoup-e2e`. Global setup launches `mediasoup-e2e`
   itself, but it stops with a clear error if another world is running.
4. **Run the suite:**

   ```sh
   FOUNDRY_ADMIN_KEY=<harness admin key> FOUNDRY_VERSION=14.368 \
     bunx playwright test -c playwright.foundry.config.ts
   ```

   If the harness world's GM is not a password-less `Gamemaster`, set
   `FOUNDRY_E2E_GM_NAME` and `FOUNDRY_E2E_GM_PASSWORD`.

**Browser:** set `PW_CHROMIUM_PATH` to use a preinstalled Chromium, for
example one under `/opt/pw-browsers/`, instead of Playwright's own.

### When provisioning fails

Every provisioning failure saves a screenshot and the page HTML to
`test-results/foundry-e2e/*.png|html`, named after the step that failed.
Failed tests attach each user's console log and a screenshot to the HTML
report at `test-results/foundry-e2e/report/`.

Foundry's pre-game screens change between builds, and the selectors in
`support/foundry-session.ts` are the place to adjust. They were taken from
the 14.368 release notes and from Foundry automation that has been verified
live on 13.351 and 14.360 to 14.368.

One assumption has not been observed directly: that launching a world
created from a `world.json` gives it the default password-less `Gamemaster`
user, either directly or through v14's `/players` gate. If `/join` offers no
such user, the join step fails and names the users it found.
