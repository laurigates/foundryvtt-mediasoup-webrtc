---
id: ADR-004
title: Integrate as a Foundry AVClient
status: accepted
created: 2026-09-30
---

# ADR-004: Integrate as a Foundry AVClient

## Context

Up to 0.7.x the module ran beside Foundry's A/V instead of inside it:

- its own scene-control buttons (connect, mic, camera);
- remote video injected into the player list;
- remote audio as `<audio>` elements on `document.body`;
- its own device, auto-connect and preview settings.

It never set `CONFIG.WebRTC.clientClass`, so core AVMaster, CameraViews and
AVSettings knew nothing about it. With core A/V enabled, core's SimplePeer
client competed with it for the camera and microphone. The scene-control and
player-list hooks used pre-v13 shapes (`controls` as an array,
`renderPlayerList`, jQuery `html`) and threw on v13, so on v13 there was no
A/V UI at all.

Foundry's documented extension point for A/V is the abstract
`foundry.av.AVClient` class. A module sets `CONFIG.WebRTC.clientClass`, and
core AVMaster instantiates it and drives it. `avclient-livekit` works this
way. It is a reference for the pattern only: it is under the Hippocratic
License 2.1, and no code is taken from it.

## Decision

- `MediaSoupAVClient extends foundry.av.AVClient` and is assigned to
  `CONFIG.WebRTC.clientClass` when the module script is imported, before
  `Game#initializeRTC` constructs AVMaster.
- Core owns the lifecycle (initialize, connect, disconnect, reestablish) and
  the UI. CameraViews renders the dock and calls `setUserVideo`. AVSettings
  holds devices, mute and hide state, voice mode and push-to-talk. The
  module's own settings are reduced to the server URL, the auth token and
  debug logging.
- `MediaSoupVTTClient` becomes a DOM-free transport core (signaling, device,
  transports, producers/consumers, reconnect, ICE restart) that emits events.
  The AVClient maps those onto core.
- The configuration dialog is ported to ApplicationV2
  (`HandlebarsApplicationMixin`). The `renderSettingsConfig` handler works
  on the `HTMLElement` the hook passes.
- The custom scene controls, player-list video and device/auto-connect
  settings are removed (a breaking change).

## Consequences

### Positive

- One A/V stack: no competition with SimplePeer, and the users' existing core
  A/V settings, dock, mute, push-to-talk and voice activation are used as
  they are.
- Much less Foundry DOM coupling; the module relies on the documented
  AVClient API instead of core markup, which changes between versions.
- The transport core can be unit-tested without Foundry or a DOM.

### Negative

- The module depends on the AVClient contract. When core changes it, the
  module has to follow. The Foundry e2e tier (`tests/e2e/foundry/`) is where
  that shows, and it needs a Foundry license to run.
- Users lose the module-specific controls and settings (a breaking change,
  recorded as such in the release notes).
- Test doubles for AVMaster, AVSettings and CameraViews must be written from
  the public API docs (Foundry's license does not allow copying core code), so
  they can drift from the real behaviour. Only the Foundry e2e tier checks
  them against core.
