# Feature Tracker

"Implemented" means covered by the unit tests, the SFU e2e tier, or both.
None of it has run inside a real Foundry server yet: the Foundry e2e tier
(`foundry-e2e.yml`) is pending its first run.

| Feature                                                  | Source  | Status      | Priority |
| -------------------------------------------------------- | ------- | ----------- | -------- |
| WebSocket signaling and transport lifecycle              | PRD-001 | implemented | must     |
| Local audio capture and production                       | PRD-001 | implemented | must     |
| Local video capture and production                       | PRD-001 | implemented | must     |
| Remote consumer creation and playback                    | PRD-001 | implemented | must     |
| Late joiners receive existing producers                  | PRD-001 | implemented | must     |
| AVClient registration (`CONFIG.WebRTC.clientClass`)      | ADR-004 | implemented | must     |
| Remote video in the core camera dock (CameraViews)       | ADR-004 | implemented | must     |
| Devices, mute, hide, voice mode, push-to-talk via AVSettings | ADR-004 | implemented | must |
| Module settings (server URL, auth token, debug logging)  | PRD-001 | implemented | must     |
| Configuration dialog (ApplicationV2)                     | ADR-004 | implemented | must     |
| Connection status on the Settings page                   | PRD-001 | implemented | must     |
| Producer pause/resume reaching remote peers              | PRD-001 | implemented | should   |
| Reconnect with backoff and ICE restart                   | PRD-001 | implemented | should   |
| Debug logging toggle                                     | PRD-001 | implemented | could    |
| Unit tests for client logic                              | PRD-001 | implemented | should   |
| SFU e2e tier (real bundle, real SFU, fake devices)       | PRD-001 | implemented | should   |
| Foundry e2e tier (real Foundry v14)                      | PRD-001 | in-progress | must     |
| TypeScript migration (Vite + bun + biome)                | ADR-003 | implemented | should   |
| Server-side audio recording                              | PRD-001 | not-started | should   |
| Scene controls, player-list video, preview overlay, device/auto-connect settings | ADR-004 | removed | — |
