# MediaSoup SFU server

A Rust [mediasoup](https://mediasoup.org/) SFU for the `mediasoup-vtt`
FoundryVTT module. The module connects to it over a WebSocket for signaling;
audio and video flow over WebRTC between each browser and this server.

One server can host several Foundry worlds: each world gets its own room and
mediasoup router.

## Requirements

- Rust **1.88** or newer (`rust-version = "1.88"`, edition 2024).
- The `rustfmt` component (the `mediasoup-sys` build script uses it).
- A C++20 compiler (`build-essential` on Debian), Python 3.10+ with `pip`, and
  `python3-dev`. `mediasoup-sys` builds the C++ worker from source and
  pip-installs `invoke`, `meson` and `ninja` into its own build directory.
- Network access during the first build: the worker build downloads its
  subprojects.

Debian **bookworm** or newer meets these. Bullseye does not (its compiler and
Python are too old), which is why the Docker image is based on bookworm.

## Build and run

```bash
cd server
cargo build --release
cp .env.example .env        # then edit .env; at least MEDIASOUP_ANNOUNCED_IP
set -a; . ./.env; set +a
./target/release/mediasoup-server
```

The binary does not read `.env` itself; export the variables before starting
it (as above, or with systemd's `EnvironmentFile=`, or with docker compose).

Logging goes to stdout. `RUST_LOG` sets the filter for the server's own logs
(default `info`, e.g. `RUST_LOG=mediasoup_server=debug`). The mediasoup
worker's own log level is `MEDIASOUP_LOG_LEVEL`.

### Local checks

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`just server-check` in the repository root runs the same three.

Building the worker is slow and needs the toolchain above. For lint-only work,
`DOCS_RS=1 cargo clippy --all-targets -- -D warnings` skips the worker build.
It does not produce a runnable binary, and `cargo test` still needs the full
build. Server CI (`.github/workflows/server-ci.yml`) runs the full build, the
tests and a Docker image build.

`cargo test` covers config validation, TLS loading, message parsing and a
signaling end-to-end suite (`tests/signaling_e2e.rs`) that runs a real server
on loopback. The browser-level SFU tests live in the repository root
(`bun run test:e2e`) and use `server/target/release/mediasoup-server`, so run
`cargo build --release` first.

## Configuration

All configuration is by environment variable (`src/config.rs`). Boolean flags
accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off` (case-insensitive); an
empty or unrecognised value means the default.

| Variable | Default | Meaning |
|---|---|---|
| `MEDIASOUP_LISTEN_ADDR` | `0.0.0.0:3000` | WebSocket listen address. An unparsable value stops startup. |
| `MEDIASOUP_HTTP_ADDR` | unset | Parsed (an unparsable value stops startup) but not used by the server at present. |
| `MEDIASOUP_NUM_WORKERS` | `1` | Number of mediasoup worker processes. Rooms are assigned to workers round-robin. Must be at least 1. |
| `MEDIASOUP_LOG_LEVEL` | `warn` | Worker log level: `debug`, `warn`, `error`, `none`. Anything else means `warn`. |
| `MEDIASOUP_LOG_TAGS` | `info` | Comma-separated worker log tags (`info`, `ice`, `dtls`, `rtp`, `srtp`, `rtcp`, `rtx`, `bwe`, `score`, `simulcast`, `svc`, `sctp`, `message`). |
| `MEDIASOUP_RTC_MIN_PORT` | `10000` | Lowest ICE/RTP port. An unparsable value means the default. |
| `MEDIASOUP_RTC_MAX_PORT` | `10100` | Highest ICE/RTP port. Must not be below the minimum. |
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | IP the WebRTC sockets bind to. `::` for IPv6 wildcard, or a concrete interface address. |
| `MEDIASOUP_ANNOUNCED_IP` | unset | Address put into ICE candidates: the public IP or DNS name clients reach this host on. **Required** when `MEDIASOUP_LISTEN_IP` is a wildcard (the default). Empty means unset. |
| `MEDIASOUP_ALLOW_UNANNOUNCED` | off | Start with a wildcard listen IP and no announced IP anyway (logs a warning). Local testing only. |
| `MEDIASOUP_ENABLE_UDP` | on | Offer UDP ICE candidates. |
| `MEDIASOUP_ENABLE_TCP` | on | Offer TCP ICE candidates (fallback for networks that block UDP). |
| `MEDIASOUP_PREFER_UDP` | on | Give UDP candidates a higher ICE priority than TCP. |
| `MEDIASOUP_AUTH_TOKEN` | unset | Shared secret clients must send in `authenticate`. Unset or empty means **no authentication** (a warning is logged). Use the same value as the module's server token setting. |
| `MEDIASOUP_TLS_CERT` | unset | PEM certificate chain for native `wss://`. |
| `MEDIASOUP_TLS_KEY` | unset | PEM private key for native `wss://`. TLS is enabled only when both are set; with just one, the server serves plain `ws://`. |

### Startup validation

After loading, the server checks the configuration and exits with a
`Configuration error` instead of starting in a state that cannot carry media:

- `MEDIASOUP_LISTEN_IP` must parse as an IP address.
- A wildcard listen IP (`0.0.0.0` or `::`) needs `MEDIASOUP_ANNOUNCED_IP`.
  Without it mediasoup would advertise the wildcard address as the ICE
  candidate, which no browser can reach, and no audio or video would flow.
  `MEDIASOUP_ALLOW_UNANNOUNCED=1` turns this error into a warning.
- At least one of `MEDIASOUP_ENABLE_UDP` and `MEDIASOUP_ENABLE_TCP` must be on.
- `MEDIASOUP_RTC_MIN_PORT` must not exceed `MEDIASOUP_RTC_MAX_PORT`.

A concrete listen IP (for example `192.168.1.10`) needs no announced IP; it is
advertised as is. Set `MEDIASOUP_ANNOUNCED_IP` as well when clients reach the
host through NAT.

## Networking

The server uses two kinds of ports:

- **Signaling:** the WebSocket port from `MEDIASOUP_LISTEN_ADDR` (TCP, default
  3000).
- **Media:** the range `MEDIASOUP_RTC_MIN_PORT`-`MEDIASOUP_RTC_MAX_PORT`, on
  **both UDP and TCP** when both protocols are enabled. Each client opens a send
  and a receive transport, and each transport takes one port per enabled
  protocol, so plan for about two ports per connected client per protocol. The
  default range of 101 ports is enough for roughly 50 clients.

Open both in the firewall, for example:

```bash
sudo ufw allow 3000/tcp
sudo ufw allow 10000:10100/udp
sudo ufw allow 10000:10100/tcp
```

Browsers on an `https://` Foundry page refuse a plain `ws://` connection, so a
real deployment needs TLS on the signaling port: either native TLS
(`MEDIASOUP_TLS_CERT` / `MEDIASOUP_TLS_KEY`) or a reverse proxy. The media
ports are not proxied; clients connect to them directly at the announced
address.

### Rooms

The `roomId` in a client's `authenticate` frame selects its room. The module
sends the Foundry world id, so players of one world share a room and different
worlds on the same server are isolated. Each room has its own mediasoup router;
the router is created when the first peer joins and released when the last one
leaves. A missing or `null` `roomId` means the room `default`. Any other value
must be a non-empty string of at most 256 bytes.

## Signaling protocol

JSON text frames over the WebSocket. The client-side counterpart is
`src/client/MediaSoupVTTClient.ts`; message type names are shared in
`src/constants/index.ts`.

### Envelopes

- **Request** (client to server): `{ "type", "requestId", "userId"?, ...fields }`.
  Fields are top-level, not nested.
- **Response**: `{ "requestId", "data" }` on success, `{ "requestId", "error" }`
  on failure. `error` is a string.
- **Notification** (server to client): `{ "type", ...fields }`, no `requestId`.

A request without `requestId` is still handled but gets no reply. A frame that
is not valid JSON, or has the wrong shape, gets `{ "requestId"?, "error" }`
(with the `requestId` when one could be read). An unknown `type` gets the error
`Unknown method: <type>`.

### Requests

All ids refer to the caller's own transports, producers and consumers, except
`producerId` in `consume`, which names another peer's producer in the same
room.

| `type` | Request fields | `data` on success | Notes |
|---|---|---|---|
| `authenticate` | `token`, `userId`, `roomId`?, `sessionId`?, `reconnect`? | `{}` | Must be the first frame. See below. A later `authenticate` is a no-op. |
| `getRouterRtpCapabilities` | none | router RTP capabilities | For `device.load()`. |
| `createWebRtcTransport` | `producing`?, `consuming`?, `sctpCapabilities`? | `{ id, iceParameters, iceCandidates, dtlsParameters, sctpParameters? }` | SCTP is enabled only when `sctpCapabilities` is sent. |
| `connectTransport` | `transportId`, `dtlsParameters` | `{}` | |
| `restartIce` | `transportId` | `{ iceParameters }` | For `transport.restartIce()`. |
| `produce` | `transportId`, `kind` (`audio`/`video`), `rtpParameters`, `appData`?, `paused`? | `{ id }` | `paused` (default `false`) creates the producer paused. Sends `newProducer` to the other peers. |
| `getProducers` | none | `{ producers: [{ producerId, userId, kind, paused }] }` | Every producer in the room except the caller's. Used on join. |
| `closeProducer` | `producerId` | `{}` | Sends `producerClosed` to the other peers. |
| `pauseProducer` | `producerId` | `{}` | Consumers of it get `producerPaused`. |
| `resumeProducer` | `producerId` | `{}` | Consumers of it get `producerResumed`. |
| `consume` | `transportId`, `producerId`, `rtpCapabilities` | `{ id, producerId, kind, rtpParameters, producerPaused }` | The consumer is created paused; resume it with `consumerResume`. Fails if the router cannot consume the producer with the given capabilities. |
| `consumerResume` | `consumerId` | `{}` | |
| `closeConsumer` | `consumerId` | `{}` | |

### Notifications

| `type` | Fields | Sent to |
|---|---|---|
| `newProducer` | `producerId`, `userId`, `kind`, `paused` | Every other peer in the room, when a producer is created. |
| `producerClosed` | `producerId` | Every other peer in the room, on `closeProducer`, disconnect or eviction. Consumers of that producer are closed on the server. |
| `producerPaused` | `producerId` | Each peer consuming that producer. |
| `producerResumed` | `producerId` | Each peer consuming that producer. |

`kind` is always lowercase `audio` or `video`.

### Connection lifecycle

1. **Authenticate.** The first text frame must be `authenticate`, sent within
   30 seconds. `token` must equal `MEDIASOUP_AUTH_TOKEN` (compared in constant
   time; ignored when no token is configured). A wrong token, an invalid
   `roomId`, a different first message or a timeout gets an error reply (when
   the frame had a `requestId`) and the connection is dropped. `userId` is the
   Foundry user id; if missing, the server uses a random id. The success reply
   is sent only after the peer has joined its room.
2. **Same user, same room.** When a `userId` joins a room it is already in (a
   reload, a second tab, a half-dead socket), the older connection is evicted:
   the other peers get `producerClosed` for its producers, its resources are
   released and its socket is closed with code **4001** and reason
   `Replaced by a newer connection for the same user`. The module does not
   reconnect after 4001, so two tabs do not keep evicting each other.
3. **Reconnects.** The module's reconnect loop sends `reconnect: true` and its
   per-page `sessionId` (at most 128 bytes; anything else counts as absent). A
   reconnect may replace only a connection with the same `sessionId`. If the
   same user is connected from another or unknown session, that is a newer tab,
   and the join is refused with `User <id> is already connected from another
   session`.
4. **Keepalive.** The server sends a WebSocket ping every 15 seconds. Any
   inbound frame, pong or otherwise, resets the count. After 3 consecutive
   pings with nothing received, the peer is dropped (so a dead client is
   noticed within about 45-60 seconds). Browsers answer pings on their own;
   these are protocol-level ping/pong frames, not JSON messages.
5. **Disconnect.** The peer leaves its room, the other peers get
   `producerClosed` for its producers, and the room's router is released once
   the room is empty.

## Deployment

### Docker

`Dockerfile` is a two-stage build on Debian bookworm (`rust:1-bookworm`
builder, `debian:bookworm-slim` runtime, non-root user). `docker-compose.yml`
maps the WebSocket port and the RTC range on UDP and TCP:

```bash
cd server
MEDIASOUP_ANNOUNCED_IP=203.0.113.7 MEDIASOUP_AUTH_TOKEN=change-me \
  docker compose up --build
```

Inside the container the server listens on `0.0.0.0`, so
`MEDIASOUP_ANNOUNCED_IP` is required; without it the container exits at
startup with the validation error above. The address must be the one browsers
use to reach the Docker host, not the container address.

Mapping a large port range through Docker's proxy is slow to start. For larger
ranges, `network_mode: host` is an alternative.

The compose file has an optional `nginx` service (profile `reverse-proxy`) for
TLS termination. It expects your own `nginx.conf` and `ssl/` next to the
compose file; neither is included.

### Reverse proxy

The proxy only needs to carry the WebSocket. Example nginx location:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 443 ssl;
    server_name sfu.example.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 120s;
    }
}
```

The module's server URL is then `wss://sfu.example.com`.

### systemd

```ini
[Unit]
Description=MediaSoup SFU for FoundryVTT
After=network.target

[Service]
Type=simple
User=mediasoup
Group=mediasoup
EnvironmentFile=/etc/mediasoup/server.env
ExecStart=/usr/local/bin/mediasoup-server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`server.env` uses the same `KEY=value` lines as `.env.example`.

## Module settings

In Foundry, enable A/V in the Audio/Video configuration and set the module
settings **MediaSoup Server WebSocket URL** (`ws://host:3000`, or `wss://...`
behind TLS) and **MediaSoup Server Auth Token** (the value of
`MEDIASOUP_AUTH_TOKEN`). The token is a world setting, so every player of the
world can read it.

## Troubleshooting

- **Exits at startup with `MEDIASOUP_ANNOUNCED_IP is not set`:** set it to the
  address clients reach the host on, or bind `MEDIASOUP_LISTEN_IP` to a
  concrete address.
- **Connects, but no audio or video:** the announced address is wrong or the
  RTC range is blocked. Check both UDP and TCP on the range, and look at the
  `iceCandidates` in the `createWebRtcTransport` response.
- **`Invalid authentication token`:** the module's token does not match
  `MEDIASOUP_AUTH_TOKEN`.
- **One client keeps dropping another:** both use the same Foundry user; see
  close code 4001 above.
- **More detail:** `RUST_LOG=mediasoup_server=debug` and, for ICE/DTLS,
  `MEDIASOUP_LOG_LEVEL=debug MEDIASOUP_LOG_TAGS=info,ice,dtls`.

## Security

See [SECURITY_AUDIT.md](SECURITY_AUDIT.md) for the authentication model, its
known limitations and dependency advisories.

## License

MIT, as the rest of the repository (see `../LICENSE`).
