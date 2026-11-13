# Security notes

What the server does and does not protect against, and the state of its
dependency advisories. Not a claim of hardening beyond what is listed (#118).

Last updated: 2026-10-27.

## Application security

### Authentication: one shared token

- The first WebSocket frame must be `authenticate`, within 30 seconds. When
  `MEDIASOUP_AUTH_TOKEN` is set, its `token` must match (length-checked,
  constant-time comparison). Otherwise the server replies with an error and
  drops the connection before allocating any room or peer resources.
- When `MEDIASOUP_AUTH_TOKEN` is unset or empty, the server accepts everyone
  and logs a warning at startup. Do not expose it to a network that way.

### Known limitation: `userId` and `roomId` are not authenticated

The token is the only credential, and it is the same for every user. In the
module it is a world setting, readable by every player of the world.

- `userId` is taken from the client as is. Anyone holding the token can claim
  any user id. Because a new connection for a user evicts that user's older
  one (close code 4001), this also lets a token holder disconnect any user,
  including the GM, and take their place in the room.
- `roomId` is also client-chosen. With several worlds on one server and one
  token, a player of one world can join another world's room by sending its
  world id. Use a separate server (or at least a separate token) per group
  that should not share A/V.

The fix is per-user credentials: a Foundry-side relay that mints signed,
short-lived tokens binding user id and world id. That is follow-up work; only
the token check in the `authenticate` handshake (`verify_token` in
`src/server.rs`) would need to change.

### Transport security

- Native TLS (`wss://`) when `MEDIASOUP_TLS_CERT` and `MEDIASOUP_TLS_KEY` both
  point at PEM files, using rustls with the `ring` provider and its safe
  default protocol versions. With only one of them set, the server serves
  plain `ws://`.
- Otherwise terminate TLS at a reverse proxy. One of the two is needed in any
  real deployment, since browsers block `ws://` from an `https://` page.
- Media is DTLS-SRTP encrypted between each browser and the SFU, as in any
  WebRTC SFU. The SFU itself sees decrypted media; there is no end-to-end
  encryption.

### Resource limits

In place (see the README's "Resource limits" for the user-facing view):

- Connection caps, total (`MEDIASOUP_MAX_CONNECTIONS`, default 500) and per
  source IP (`MEDIASOUP_MAX_CONNECTIONS_PER_IP`, default 32), checked right
  after the TCP accept, before any TLS or WebSocket handshake. The slot is
  released when the connection task ends (an RAII guard in `src/limits.rs`).
- A 10-second deadline on the TLS plus WebSocket handshake, then the existing
  30 seconds for `authenticate`. A connection cannot sit in the pre-auth
  phase indefinitely.
- Inbound WebSocket messages and frames are capped at 256 KiB
  (`MAX_SIGNALING_MESSAGE_SIZE` in `src/server.rs`; the library default was
  64 MiB per message). A bigger one closes the connection.
- Per peer: at most 8 transports, 16 producers and 512 consumers
  (`MAX_*_PER_PEER` in `src/room.rs`). Over the limit, the request fails with
  an `Invalid request` error; the connection stays open.
- Each peer's outgoing queue is bounded (1024 messages). A peer that stops
  reading its socket is disconnected when the queue fills, instead of the
  server buffering for it without bound.

### Known gaps

- **Resource limits, remaining:**
  - The per-IP cap counts addresses, not users. Behind a reverse proxy all
    clients share the proxy's address (raise the cap or set it to 0 there),
    and an attacker with many addresses (e.g. an IPv6 range) is held only by
    the total cap. Per-user limits need per-user identity (#130).
  - No rate limit on signaling requests. A connected peer can still send
    requests as fast as the server answers them; each is bounded by the
    per-peer object limits above.
  - No cap on rooms or on peers per room beyond the connection caps; with one
    shared token, any token holder can create rooms (one router each).
  - The RTC port range is shared: 8 transports per peer times the connection
    caps can exceed it, after which transport creation fails for everyone.
- **Per-user identity:** see above; per-user credentials are tracked in #130.

## Dependencies

### Recent changes

- **rustls-pemfile removed.** It is unmaintained
  ([RUSTSEC-2025-0134](https://rustsec.org/advisories/RUSTSEC-2025-0134)).
  PEM certificate and key loading now uses the `PemObject` API from
  `rustls-pki-types`, re-exported by rustls
  (`CertificateDer::pem_slice_iter`, `PrivateKeyDer::from_pem_slice`). A unit
  test loads a generated certificate/key pair and checks the error for a PEM
  file without a key and one without certificates.
- `warp`, `config`, `slab` and `tokio-test` removed; they were declared but
  never used.
- mediasoup 0.20 to 0.28.1 (mediasoup-sys 0.18.1), tokio-tungstenite 0.27 to
  0.30, thiserror 1 to 2, dashmap 5 to 6.
- Rust edition 2024, MSRV 1.88. The worker now needs a C++20 compiler and
  Python 3.10+, so the Docker image moved from Debian bullseye to bookworm.

### Remaining advisories (transitive, through mediasoup)

Crate versions and paths as in the current `Cargo.lock` (`cargo tree -i`). The
advisory list itself was not re-run with `cargo audit` for this update; run it
before relying on this list.

| Advisory | Crate | Path | Assessment |
|---|---|---|---|
| RUSTSEC-2024-0436 (unmaintained) | paste 0.1.18 | paste → bitpattern (proc-macro) → h264-profile-level-id → mediasoup | Compile time only. |
| RUSTSEC-2024-0375 (unmaintained) | atty 0.2.14 | atty → planus-translation → mediasoup-sys (build dependency) | Build time only; not in the binary. |
| RUSTSEC-2021-0145 (unsound) | atty 0.2.14 | same | Same. |
| RUSTSEC-2024-0384 (unmaintained) | instant 0.1.13 | instant → fastrand 1.9 → futures-lite 1 / mediasoup | Only compiled for wasm targets; not in the Linux build. |

None of them has a fix available short of mediasoup updating its own
dependencies.

```bash
# Everything:
cargo audit

# Accepting the known transitive advisories above:
cargo audit --ignore RUSTSEC-2024-0436 --ignore RUSTSEC-2024-0375 \
            --ignore RUSTSEC-2021-0145 --ignore RUSTSEC-2024-0384
```
