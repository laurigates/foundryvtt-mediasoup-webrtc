# Security notes

What the server does and does not protect against, and the state of its
dependency advisories. Not a claim of hardening beyond what is listed (#118).

Last updated: 2026-09-30.

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

### Known gaps

- **Resource limits:** no per-IP connection cap, no per-peer limit on
  transports, producers or consumers, no size limit on signaling frames beyond
  the WebSocket library's defaults.
- **Per-user identity:** see above.

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
