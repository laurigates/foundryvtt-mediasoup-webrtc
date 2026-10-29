# Client architecture

The module's client has two layers. Why it is built as a Foundry AVClient,
and what that replaced, is in
[ADR-004](blueprint/adrs/ADR-004-foundry-avclient-integration.md); this page
only lists the surface each layer exposes.

| Layer | File | Knows about |
|-------|------|-------------|
| AVClient | `src/client/MediaSoupAVClient.ts` | Foundry: AVMaster, AVSettings, CameraViews, `game.settings`, hooks, notifications |
| Transport core | `src/client/MediaSoupVTTClient.ts` | The SFU: WebSocket signaling, the mediasoup `Device`, transports, producers, consumers, reconnect, ICE restart. No DOM, no Foundry globals. |

`src/mediasoup-vtt.ts` sets `CONFIG.WebRTC.clientClass = MediaSoupAVClient`
at import time. Core AVMaster (`game.webrtc`) then constructs it and drives
its lifecycle. The AVClient owns one `MediaSoupVTTClient` (`transport`) and
reacts to its events.

## MediaSoupAVClient

`extends foundry.av.AVClient`. Signatures follow the v14 (14.368) API page;
v13 is the minimum supported version.

### foundry.av.AVClient methods it implements

| Method | What it does here |
|--------|-------------------|
| `initialize()` | First call only: creates the mediasoup `Device` (`transport.prepareDevice()`). Notifies the user if the browser cannot run mediasoup-client. |
| `connect()` | Reads `mediaSoupServerUrl` / `mediaSoupAuthToken`, validates the URL, joins the room `game.world.id` as `game.user.id`, captures local media from the AVSettings devices and starts producing. Returns `false` on a bad URL, a failed connection or a superseded attempt. |
| `disconnect()` | Closes the SFU connection, stops the local tracks, drops the remote streams. |
| `getAudioSinks()`, `getAudioSources()`, `getVideoSources()` | `navigator.mediaDevices.enumerateDevices()`, filtered by kind, as `{deviceId: label}`. |
| `getConnectedUsers()` | The local user; while connected or reconnecting, also every active Foundry user (a tile even without media). |
| `getMediaStreamForUser(userId)` | The local stream, or the remote user's stream of consumed tracks. |
| `getLevelsStreamForUser(userId)` | An audio-only stream for level detection; locally a clone of the mic track, so a paused producer does not silence voice activation. |
| `isAudioEnabled()`, `isVideoEnabled()` | Whether a local audio / video track was captured. |
| `toggleAudio(enable)` | Mute stops the broadcast; unmute resumes it only in "always" voice mode. |
| `toggleBroadcast(broadcast)` | Pauses or resumes the mic producer (push-to-talk, voice activation). A muted user never broadcasts. |
| `toggleVideo(enable)` | Pauses or resumes the webcam producer (hidden by the user or the GM). |
| `setUserVideo(userId, videoElement)` | Attaches the stream to a CameraViews `<video>`, mutes the local echo, applies "mute all" and the audio output device (`setSinkId`), and sets `data-mediasoup-audio-paused` / `data-mediasoup-video-paused` for paused remote producers. |
| `onSettingsChanged(changed)` | Device changes recapture media; voice mode, mute and hide changes update the broadcast; display settings re-render the dock. |
| `updateLocalStream()` | Recaptures local media with the current devices and swaps the new tracks into the existing producers. |

The base class's `isMuted`, `isVoiceActivated`, `isVoiceAlways` and
`isVoicePTT` getters are used as inherited.

### Additions beyond the base class

| Member | Purpose |
|--------|---------|
| `transport` | The `MediaSoupVTTClient` instance (injectable through the constructor's third argument, for tests). |
| `isConnected`, `isConnecting` | Mirror the transport; read by the status block on the Settings page. |
| `isRemoteProducerPaused(userId, kind)` | Last pause state the server reported for a remote producer. |
| `render()` | Coalesces dock re-renders into one microtask (`AVMaster#render`, falling back to `ui.webrtc`). |
| `destroy()` | Unsubscribes from the transport and the `userConnected` hook, disconnects, stops local tracks. |

## MediaSoupVTTClient events

`MediaSoupVTTClient` extends a small typed emitter
(`src/client/TypedEmitter.ts`): `on(event, listener)` returns an unsubscribe
function, `once` and `off` work as usual, and a listener that throws is
logged without stopping the others. The event map is
`MediaSoupVTTClientEvents`.

| Event | Payload | Emitted when |
|-------|---------|--------------|
| `consumerAdded` | `RemoteTrackInfo` | A remote producer was consumed and its track is ready. |
| `consumerUpdated` | `RemoteTrackInfo` | A consumed track's metadata changed: the server sent `producerPaused` / `producerResumed`. |
| `consumerRemoved` | `RemoteTrackInfo` | A consumer was closed (remote producer closed, or local teardown). |
| `stateChanged` | `StateChange` | The connection state changed. |
| `transportStateChanged` | `TransportStateChange` | The current send or recv transport's `connectionstatechange` fired. |
| `localTrackEnded` | `LocalTrackEnded` | A produced local track ended (device removed), or a wanted track was found ended when re-producing after a reconnect. |
| `reconnecting` | `ReconnectScheduled` | A reconnect attempt was scheduled by the backoff loop. |
| `iceRestart` | `IceRestartStarted` | An ICE restart started on a transport. |

`MediaSoupAVClient` subscribes to `consumerAdded`, `consumerUpdated`,
`consumerRemoved`, `stateChanged` and `localTrackEnded`. The other three are
for diagnostics and tests.

### Payload types

All exported from `src/client/MediaSoupVTTClient.ts`.

```ts
type ClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
type TransportDirection = 'send' | 'recv';

interface RemoteTrackInfo {
  userId: string;
  kind: 'audio' | 'video';
  track: MediaStreamTrack;
  consumerId: string;
  producerId: string;
  producerPaused: boolean; // from the consume response, then kept current
}

interface StateChange {
  state: ClientState;
  previous: ClientState;
  reason?: string; // set when the change was not requested, e.g. a socket close
}

interface TransportStateChange {
  direction: TransportDirection;
  state: RTCPeerConnectionState; // mediasoup-client ConnectionState
}

interface LocalTrackEnded {
  tag: 'mic' | 'webcam';
  kind: 'audio' | 'video';
}

interface ReconnectScheduled {
  attempt: number; // 1-based, runs after delayMs
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

interface IceRestartStarted {
  direction: TransportDirection;
  attempt: number; // 1-based since the transport was last connected
}
```

### Connection states

- `disconnected`: not connected, nothing in flight.
- `connecting`: a join started by `connect()` is in flight.
- `connected`: joined the room on the SFU.
- `reconnecting`: the connection was lost and the transport core's backoff
  loop is running. `MediaSoupAVClient` clears remote streams and notifies
  the user; it does not call `AVMaster#reestablish`.
- `failed`: the last attempt failed, the loop gave up, or the server
  replaced this connection (the same user joined elsewhere). Nothing retries
  until `connect()` runs again.

The signaling messages behind these events are listed in
`SIG_MSG_TYPES` (`src/constants/index.ts`).
