---
id: PRD-001
title: MediaSoupVTT Client Module
status: draft
created: 2026-03-05
source: REQUIREMENTS.md, README.md
---

# PRD-001: MediaSoupVTT Client Module

## Problem Statement

FoundryVTT lacks a self-hosted WebRTC A/V solution that gives session hosts
direct control over the media pipeline. Existing solutions such as
`avclient-livekit` depend on third-party cloud infrastructure and cannot
provide server-side audio recording. Game masters hosting D&D sessions need
the ability to capture raw audio streams on their own server so that external
helper applications (e.g., transcription and summarization tools) can process
the recordings without relying on cloud providers.

## Goals

- Replace existing FoundryVTT A/V modules with a fully self-hosted alternative.
- Enable server-side audio recording by delivering audio RTP streams to a
  controllable MediaSoup server.
- Provide a complete, low-latency A/V experience comparable to existing
  solutions.
- Keep the client module installable via the standard FoundryVTT module
  manifest URL workflow.

## Non-Goals

- The MediaSoup server itself (covered by server/ component).
- The external D&D helper application that consumes recordings.
- TURN/STUN server provisioning.

## Requirements

From the release after 0.7.x, the module is a Foundry AVClient ([ADR-004](../adrs/ADR-004-foundry-avclient-integration.md)):
core AVMaster, CameraViews and AVSettings provide the lifecycle and the UI, and
the requirements below are met through them.

### Connection Management

| ID         | Requirement                                                                                                                                | Priority |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| FR-CON-001 | The GM shall configure the WebSocket URL (and auth token) of the MediaSoup server in the module's world settings.                          | Must     |
| FR-CON-002 | The client shall connect when core A/V is enabled (conference mode not Disabled); core AVMaster starts and stops the connection.           | Must     |
| FR-CON-003 | *(Withdrawn.)* A separate auto-connect option is not needed; core connects on world load when A/V is enabled.                               | —        |
| FR-CON-004 | The client shall implement the WebSocket signaling protocol (authenticate into the world's room, load router RTP caps, create/connect send and receive transports). | Must |
| FR-CON-005 | Connection status shall be surfaced in the UI (the module's section of the Settings page; notifications on errors).                         | Must     |
| FR-CON-006 | The client shall reconnect after unexpected disconnections (backoff) and restart ICE on transport loss.                                    | Should   |

### Local Media Management

| ID         | Requirement                                                                                                  | Priority |
| ---------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| FR-LMM-001 | The client shall request browser permission for microphone and camera when A/V connects.                     | Must     |
| FR-LMM-002 | The client shall capture from the devices chosen in core Configure Audio/Video and follow changes to them.   | Must     |
| FR-LMM-003 | The client shall create MediaSoup producers for the captured audio and video.                                | Must     |
| FR-LMM-004 | Core mute/hide, push-to-talk and voice activation shall pause and resume the producers at the SFU.           | Must     |
| FR-LMM-005 | *(Withdrawn.)* The local preview is core's own dock tile; the module adds no overlay.                        | —        |

### Remote Media Management

| ID         | Requirement                                                                                                    | Priority |
| ---------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| FR-RMM-001 | The client shall receive new remote producers (including those that existed before it joined) and consume them. | Must     |
| FR-RMM-002 | Remote audio and video shall play in core's camera dock (CameraViews via `setUserVideo`).                     | Must     |
| FR-RMM-003 | The client shall drop remote tracks when remote users leave or close their producers.                         | Must     |
| FR-RMM-004 | Remote producer pause/resume shall be reflected in the dock.                                                  | Should   |

### User Interface

| ID         | Requirement                                                                                          | Priority |
| ---------- | ---------------------------------------------------------------------------------------------------- | -------- |
| FR-UIX-001 | A/V controls shall be core's (camera dock, Configure Audio/Video); the module adds none of its own.   | Must     |
| FR-UIX-002 | Remote video shall render in core's camera dock.                                                     | Must     |
| FR-UIX-003 | Local and remote mute/camera state and speaking indicators shall show through core's dock.           | Must     |
| FR-UIX-004 | Error messages shall be localized and surfaced through the FoundryVTT notification system.           | Should   |
| FR-UIX-005 | Dialogs shall be ApplicationV2; render-hook handlers shall work on the `HTMLElement` they receive.   | Must     |

### Configuration

| ID         | Requirement                                                                                                   | Priority |
| ---------- | ------------------------------------------------------------------------------------------------------------- | -------- |
| FR-CFG-001 | Module settings shall be on the Settings page (Configure Settings > MediaSoupVTT), plus a GM-only config menu. | Must     |
| FR-CFG-002 | Settings: server WebSocket URL and auth token (world), debug logging (client). No others.                     | Must     |
| FR-CFG-003 | Devices, mute, voice mode and push-to-talk shall stay in core AVSettings, not module settings.                | Must     |

### Non-Functional Requirements

| ID          | Category      | Requirement                                                                                          |
| ----------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| NFR-PRF-001 | Performance   | Plugin CPU/memory overhead shall not noticeably degrade FoundryVTT responsiveness.                   |
| NFR-PRF-002 | Performance   | Audio latency shall be low enough for natural conversation.                                          |
| NFR-REL-001 | Reliability   | Connections shall remain stable under normal network conditions.                                     |
| NFR-REL-002 | Reliability   | Camera and microphone resources shall be released on disconnect.                                     |
| NFR-CMP-001 | Compatibility | Minimum v13; v14 (14.368) is the target. `module.json` `verified` is raised only after the Foundry e2e tier passes on that build. |
| NFR-CMP-002 | Compatibility | Must function in Chromium-based browsers (primary FoundryVTT target).                                |
| NFR-SEC-001 | Security      | WSS and DTLS-SRTP shall be used in production deployments.                                           |
| NFR-SEC-002 | Security      | No sensitive user data shall be persisted beyond session scope.                                      |
| NFR-LIC-001 | Licensing     | No Foundry core code in the repository; test doubles are written from the public API docs.           |

## Signaling Protocol

The client uses a WebSocket request/response protocol. The message types are
defined in `src/constants/index.ts`; each request has a match arm in
`server/src/server.rs`, and each notification is sent from `server/src/room.rs`.

- Requests: `authenticate` (token, user id, `roomId` = world id),
  `getRouterRtpCapabilities`, `createWebRtcTransport`, `connectTransport`,
  `restartIce`, `produce`, `getProducers`, `closeProducer`, `pauseProducer`,
  `resumeProducer`, `consume`, `consumerResume`, `closeConsumer`.
- Notifications: `newProducer`, `producerClosed`, `producerPaused`,
  `producerResumed`.
- Close code 4001: a newer connection for the same user replaced this one; the
  client does not reconnect.

## Dependencies

- `mediasoup-client` ^3.24 - Client-side WebRTC and MediaSoup abstractions, bundled (imported as a namespace; v3 has no default export)
- FoundryVTT API (`foundry.av.AVClient`, AVMaster, AVSettings, CameraViews, settings, hooks, ApplicationV2) - Platform integration surface
- Separate MediaSoup Rust server (see `server/`) - Required for signaling and media forwarding

## Acceptance Criteria

1. A player can join a FoundryVTT world, connect to the MediaSoup server via
   the configured URL, and exchange live audio and video with other connected
   players.
2. Mute and camera-off toggles work in real time and are reflected in other
   players' UIs.
3. The server receives RTP audio streams that can be recorded server-side
   (recording itself is not implemented yet).
4. The module installs cleanly from the manifest URL on FoundryVTT v13 and
   v14, and the Foundry e2e tier passes on the verified build.
