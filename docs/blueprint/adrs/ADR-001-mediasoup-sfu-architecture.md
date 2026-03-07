---
id: ADR-001
title: MediaSoup SFU Architecture
status: accepted
created: 2026-03-05
---

# ADR-001: MediaSoup SFU Architecture

## Context

The project requires real-time audio and video communication between multiple
FoundryVTT players. Several architectural models exist for multi-party WebRTC:

- **Mesh (peer-to-peer)**: Every client connects directly to every other client.
  Upload bandwidth scales with the number of participants (N-1 streams sent
  per client). No server media processing required.
- **MCU (Multipoint Control Unit)**: A central server decodes all streams,
  mixes them, and re-encodes a single composite stream. High server CPU cost;
  low client bandwidth.
- **SFU (Selective Forwarding Unit)**: A central server receives each
  participant's streams and selectively forwards them to other participants
  without decode/re-encode. Server CPU scales moderately; client upload is
  bounded to one stream per media type.

An additional hard requirement is **server-side audio recording**: the server
must intercept raw RTP audio for transcription/summarization by an external
D&D helper application. This requires a server that has access to the media
plane, ruling out pure peer-to-peer mesh.

MediaSoup is an open-source Node.js/C++ SFU library with a separate Rust
binding (`mediasoup` crate), a mature JavaScript client library
(`mediasoup-client`), and proven production use.

## Decision

Adopt the **MediaSoup SFU** architecture implemented in Rust (`server/`)
using the `mediasoup` crate.

Key design points:

- The Rust server hosts one or more MediaSoup Workers (OS processes) and a
  Router per game session/room.
- Clients connect via a WebSocket signaling channel, negotiate RTP
  capabilities, and create WebRTC transports with DTLS-SRTP.
- Each client produces one audio and one video stream via a Send Transport.
  The server forwards those streams to all other participants via Receive
  Transports (consumers).
- Server-side recording is implemented by piping incoming audio RTP to an
  external recorder (e.g., FFmpeg) within the server process, satisfying the
  D&D helper application requirement.
- The number of MediaSoup Workers is configurable via `MEDIASOUP_NUM_WORKERS`
  to scale across CPU cores.

## Consequences

### Positive

- Server-side audio recording is possible without additional infrastructure.
- Client upload bandwidth is bounded to one audio + one video stream regardless
  of participant count.
- DTLS-SRTP encryption is built into the MediaSoup transport layer.
- Rust provides memory safety and high throughput for the media-forwarding hot
  path.
- Docker support (`server/docker-compose.yml`) simplifies deployment.
- The `mediasoup-client` JS library abstracts browser WebRTC APIs, providing
  a stable client-side programming model.

### Negative

- Players must run or have access to a self-hosted server; there is no
  zero-infrastructure option.
- The server requires UDP ports (default 10000-10100) to be reachable, which
  may require firewall and NAT configuration (`MEDIASOUP_ANNOUNCED_IP`).
- The Rust server adds a second language/toolchain (`cargo`) that contributors
  must be familiar with.
- WebSocket signaling protocol must be kept in sync between the client
  (`src/constants/index.js`) and the server (`server/src/signaling.rs`) --
  changes to one require matching changes in the other.
