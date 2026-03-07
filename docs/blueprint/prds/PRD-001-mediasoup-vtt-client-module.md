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

### Connection Management

| ID         | Requirement                                                                                                                                | Priority |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| FR-CON-001 | Users shall configure the WebSocket URL of their MediaSoup server in module settings.                                                      | Must     |
| FR-CON-002 | Users shall be able to manually initiate a connection via a scene control button.                                                          | Must     |
| FR-CON-003 | Auto-connect on world load shall be a configurable option.                                                                                 | Should   |
| FR-CON-004 | The client shall implement the WebSocket signaling protocol (join room, load router RTP caps, create/connect send and receive transports). | Must     |
| FR-CON-005 | Connection status (disconnected / connecting / connected / error) shall be surfaced in the UI.                                             | Must     |
| FR-CON-006 | The client shall attempt graceful reconnection after unexpected disconnections.                                                            | Should   |

### Local Media Management

| ID         | Requirement                                                                                        | Priority |
| ---------- | -------------------------------------------------------------------------------------------------- | -------- |
| FR-LMM-001 | The client shall request browser permission for microphone and camera on first use.                | Must     |
| FR-LMM-002 | Users shall be able to select preferred audio and video input devices when multiple are available. | Must     |
| FR-LMM-003 | The client shall capture audio and video from selected devices and create MediaSoup producers.     | Must     |
| FR-LMM-004 | Scene controls shall expose mute/unmute (microphone) and camera on/off toggle buttons.             | Must     |
| FR-LMM-005 | A local camera preview shall be displayed as an overlay (optional but implemented).                | Should   |

### Remote Media Management

| ID         | Requirement                                                                                                   | Priority |
| ---------- | ------------------------------------------------------------------------------------------------------------- | -------- |
| FR-RMM-001 | The client shall receive server notifications for new remote producers and create consumers automatically.    | Must     |
| FR-RMM-002 | Remote audio tracks shall play automatically; remote video tracks shall render in the FoundryVTT player list. | Must     |
| FR-RMM-003 | The client shall clean up media elements when remote users leave or disable their streams.                    | Must     |
| FR-RMM-004 | Producer pause/resume state changes from the server shall be reflected in the UI.                             | Should   |

### User Interface

| ID         | Requirement                                                                                                      | Priority |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | -------- |
| FR-UIX-001 | A/V controls (connect, mute, camera, settings) shall integrate with FoundryVTT scene controls.                   | Must     |
| FR-UIX-002 | Remote video feeds shall render inside or adjacent to the FoundryVTT player list without obstructing the canvas. | Must     |
| FR-UIX-003 | Visual indicators shall convey local mute/camera status, remote user status, and connection state.               | Must     |
| FR-UIX-004 | Error messages shall be user-friendly and surfaced through the FoundryVTT notification system.                   | Should   |

### Configuration

| ID         | Requirement                                                                              | Priority |
| ---------- | ---------------------------------------------------------------------------------------- | -------- |
| FR-CFG-001 | All settings shall be accessible from Game Settings > Module Settings > MediaSoupVTT.    | Must     |
| FR-CFG-002 | Required setting: MediaSoup Server WebSocket URL.                                        | Must     |
| FR-CFG-003 | Optional settings: default audio/video devices, auto-connect flag, debug logging toggle. | Could    |

### Non-Functional Requirements

| ID          | Category      | Requirement                                                                        |
| ----------- | ------------- | ---------------------------------------------------------------------------------- |
| NFR-PRF-001 | Performance   | Plugin CPU/memory overhead shall not noticeably degrade FoundryVTT responsiveness. |
| NFR-PRF-002 | Performance   | Audio latency shall be low enough for natural conversation.                        |
| NFR-REL-001 | Reliability   | Connections shall remain stable under normal network conditions.                   |
| NFR-REL-002 | Reliability   | Camera and microphone resources shall be released on disconnect.                   |
| NFR-CMP-001 | Compatibility | Must support FoundryVTT v10.291 through v13.330.                                   |
| NFR-CMP-002 | Compatibility | Must function in Chromium-based browsers (primary FoundryVTT target).              |
| NFR-SEC-001 | Security      | WSS and DTLS-SRTP shall be used in production deployments.                         |
| NFR-SEC-002 | Security      | No sensitive user data shall be persisted beyond session scope.                    |

## Signaling Protocol

The client uses a WebSocket request/response protocol with these message types
(defined in `src/constants/index.js`):

- `getRouterRtpCapabilities` - Fetch server codec capabilities
- `createWebRtcTransport` - Create a send or receive transport
- `connectTransport` - Provide DTLS parameters to the server
- `produce` - Announce a new local producer (audio or video)
- `consume` - Request consumption of a remote producer
- `pauseProducer` / `resumeProducer` - Toggle local stream state

## Dependencies

- `mediasoup-client` ^3.7.6 - Client-side WebRTC and MediaSoup abstractions
- FoundryVTT API (hooks, settings, UI) - Platform integration surface
- Separate MediaSoup Rust server (see `server/`) - Required for signaling and media forwarding

## Acceptance Criteria

1. A player can join a FoundryVTT world, connect to the MediaSoup server via
   the configured URL, and exchange live audio and video with other connected
   players.
2. Mute and camera-off toggles work in real time and are reflected in other
   players' UIs.
3. The server receives RTP audio streams that can be recorded server-side.
4. The module installs cleanly from the manifest URL on FoundryVTT v10-v13.
