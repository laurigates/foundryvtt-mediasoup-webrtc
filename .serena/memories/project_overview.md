# Project Overview: foundryvtt-mediasoup-webrtc

## Purpose
A **FoundryVTT WebRTC plugin** that uses MediaSoup as an SFU (Selective Forwarding Unit) for real-time audio/video communication between tabletop gaming players. The plugin enables server-side audio recording for external D&D helper applications while providing a complete A/V solution for tabletop gaming sessions.

## Tech Stack

### Frontend (Client Plugin)
- **Language**: JavaScript (ES2022, ES modules)
- **Bundler**: Rollup with terser minification
- **Linting**: ESLint
- **External Dependency**: mediasoup-client library
- **Platform**: FoundryVTT v10-v13

### Backend (MediaSoup Server)
- **Language**: Rust (2021 edition)
- **Runtime**: Tokio async runtime
- **WebSocket**: tokio-tungstenite
- **HTTP Server**: Warp
- **MediaSoup**: mediasoup Rust bindings v0.18

### Testing
- **Framework**: Playwright
- **Type**: Integration tests with mocked FoundryVTT environment
- **Browsers**: Chromium, Firefox, WebKit
- **Server Tests**: Cargo test (Rust)

## Project Structure

```
foundryvtt-mediasoup-webrtc/
├── src/                          # Client plugin source
│   ├── client/
│   │   └── MediaSoupVTTClient.js # Core WebRTC client
│   ├── constants/
│   │   └── index.js              # Module constants
│   ├── ui/
│   │   ├── settings.js           # Settings registration
│   │   ├── sceneControls.js      # Scene controls integration
│   │   ├── playerList.js         # Player list video integration
│   │   └── styles.js             # CSS injection
│   ├── utils/
│   │   └── logger.js             # Logging utilities
│   └── mediasoup-vtt.js          # Main entry point
├── server/                       # Rust MediaSoup server
│   ├── src/                      # Server source code
│   ├── Cargo.toml                # Rust dependencies
│   └── Dockerfile                # Container build
├── tests/                        # Integration tests
│   └── integration/
│       ├── setup/                # Test environment setup
│       ├── specs/                # Test specifications
│       └── fixtures/             # Test data
├── dist/                         # Built output (generated)
├── styles/                       # CSS assets
├── lang/                         # Localization files
└── templates/                    # HTML templates
```

## Architecture Patterns

### Signaling Protocol
- WebSocket-based with request/response pattern
- Message types defined in `SIG_MSG_TYPES` constant
- Handles MediaSoup transport creation, producer/consumer lifecycle

### Media Flow
- Local streams → Producers → Send Transport → MediaSoup Server
- MediaSoup Server → Receive Transport → Consumers → Remote streams

### State Management
- `producers` Map: Local media streams (audio/video)
- `consumers` Map: Remote media streams by consumer ID
- `remoteUserStreams` Map: User-centric view of remote audio/video tracks

### FoundryVTT Integration
- Uses Hooks API for lifecycle events (init, ready)
- Settings API for configuration
- UI integration through scene controls and player list
