# MediaSoupVTT - FoundryVTT WebRTC Module

A complete WebRTC audio/video communication solution for FoundryVTT using MediaSoup SFU architecture, featuring both client module and Rust server implementation.

## 🌟 Features

### Client Module

- 🎤 **Real-time Audio**: Voice chat with push-to-talk and mute controls
- 📹 **Video Streaming**: Webcam sharing with local preview and remote display
- 🎛️ **Device Management**: Select preferred microphone and camera devices
- 🎮 **FoundryVTT Integration**: Scene controls and player list integration
- 🔧 **WebRTC Transport**: Full producer/consumer lifecycle management

### Rust Server

- ⚡ **High Performance**: Multi-worker Rust implementation for low latency
- 🏗️ **SFU Architecture**: Efficient selective forwarding for multi-party communication
- 📊 **Server Recording**: Built-in support for server-side audio recording
- 🔒 **Secure**: DTLS-SRTP encryption with configurable network settings
- 🐳 **Production Ready**: Docker support with reverse proxy configuration

## 📋 Requirements

### FoundryVTT Client

- FoundryVTT v10.291+ (verified up to v13.330)
- Modern web browser with WebRTC support (Chrome/Chromium recommended)
- Microphone and/or camera access permissions

### Server Infrastructure

- Linux/macOS server with Rust 1.70+
- Network connectivity for WebRTC (UDP ports)
- Optional: Docker for containerized deployment
- Optional: Reverse proxy for SSL termination

## 🚀 Quick Start

### 1. Deploy the MediaSoup Server

```bash
cd server
cp .env.example .env
# Edit .env with your configuration
cargo run --release
```

**Docker Deployment:**

```bash
cd server
docker-compose up -d
```

The server will start on `localhost:3000` with WebSocket signaling and UDP ports `10000-10100` for media.

### 2. Install FoundryVTT Module

**Easy Installation (Recommended):**

1. Open FoundryVTT and navigate to **Game Settings → Modules**
2. Click **Install Module**
3. Paste this manifest URL into the **Manifest URL** field:
   ```
   https://github.com/laurigates/foundryvtt-mediasoup-webrtc/releases/latest/download/module.json
   ```
4. Click **Install** and wait for the download to complete

**Manual Installation:**

```bash
# Download the latest release
wget https://github.com/laurigates/foundryvtt-mediasoup-webrtc/releases/latest/download/mediasoup-vtt.zip

# Extract to FoundryVTT modules directory
unzip mediasoup-vtt.zip -d /path/to/foundrydata/Data/modules/mediasoup-vtt/
```

**Development Build:**

```bash
bun install
bun run build   # or: just build
cp -r dist/. /path/to/foundrydata/Data/modules/mediasoup-vtt/
```

### 3. Configure and Connect

1. Enable the **MediaSoupVTT** module in FoundryVTT
2. Set **MediaSoup Server URL** in module settings: `ws://your-server:3000`
3. Click the headset button in scene controls to connect
4. Use microphone/camera buttons to start streaming

## 🏗️ Architecture

### Client-Server Communication

```mermaid
graph TB
    subgraph "FoundryVTT Client"
        A[MediaSoupVTTClient.js]
        B[Scene Controls]
        C[Player List UI]
        D[Local Media]
    end

    subgraph "Network Layer"
        E[WebSocket Signaling]
        F[WebRTC Transports]
    end

    subgraph "Rust Server"
        G[WebSocket Handler]
        H[Room Manager]
        I[MediaSoup Router]
    end

    subgraph "MediaSoup Workers"
        J[Worker 1]
        K[Worker 2]
        L[Worker N]
    end

    A -->|Control Messages| E
    E -->|Signaling Protocol| G
    G --> H
    H --> I
    I --> J
    I --> K
    I --> L

    D -->|Audio/Video| F
    F -->|RTP Streams| I

    B -.->|User Actions| A
    C -.->|Display Remote| A
```

### Key Components

**FoundryVTT Module (`src/`):**

- `MediaSoupVTTClient.js` - Core WebRTC client with signaling protocol
- `settings.js` - Device enumeration and configuration
- `sceneControls.js` - A/V control buttons
- `playerList.js` - Remote video display integration

**Rust Server (`server/src/`):**

- `server.rs` - WebSocket signaling and request handling
- `room.rs` - Peer and media stream management
- `signaling.rs` - Protocol implementation matching client
- `config.rs` - Environment-based configuration

## ⚙️ Configuration

### Server Configuration (`.env`)

```bash
# WebSocket server address
MEDIASOUP_LISTEN_ADDR=0.0.0.0:3000

# MediaSoup workers
MEDIASOUP_NUM_WORKERS=2
MEDIASOUP_LOG_LEVEL=warn

# RTC port range for media
MEDIASOUP_RTC_MIN_PORT=10000
MEDIASOUP_RTC_MAX_PORT=10100

# Public IP for NAT traversal (if needed)
MEDIASOUP_ANNOUNCED_IP=your-public-ip
```

### Client Configuration

Access via **Game Settings → Module Settings → MediaSoupVTT**:

- **MediaSoup Server URL**: `ws://your-server:3000` or `wss://domain.com:3000`
- **Auto-connect**: Connect automatically when joining a world
- **Default Devices**: Preferred microphone/camera (auto-populated)
- **Debug Logging**: Enable detailed console logging

## 🌐 Production Deployment

### SSL/TLS Setup (Recommended)

Use Nginx reverse proxy for SSL termination:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
    }
}
```

### Firewall Configuration

Open required ports:

```bash
# WebSocket signaling
sudo ufw allow 3000/tcp

# RTC media streams
sudo ufw allow 10000:10100/udp
```

### Docker Production

```yaml
# docker-compose.yml
version: "3.8"
services:
  mediasoup-server:
    build: ./server
    ports:
      - "3000:3000"
      - "10000-10100:10000-10100/udp"
    environment:
      - MEDIASOUP_ANNOUNCED_IP=your-public-ip
    restart: unless-stopped
```

## 🔧 Development

### Client Development

```bash
# Vite dev server (HMR, proxies to Foundry on :30000)
just dev            # or: bun run dev

# Typecheck + build + lint + test — the local gate
just check

# Linting / formatting (biome)
bun run lint
bun run lint:fix

# Production build → dist/mediasoup-vtt.mjs
just build          # or: bun run build
```

### Server Development

```bash
cd server

# Format and lint
cargo fmt
cargo clippy

# Run tests
cargo test

# Development build
cargo run
```

### Protocol Implementation

The signaling protocol supports these message types:

- `getRouterRtpCapabilities` - Get server RTP capabilities
- `createWebRtcTransport` - Create send/receive transports
- `connectTransport` - Connect transport with DTLS parameters
- `produce` - Start media production (audio/video)
- `consume` - Start media consumption from other peers
- `pauseProducer` / `resumeProducer` - Control media streaming

## 📊 Monitoring and Logging

### Server Logs

```bash
# Structured logging with tracing
RUST_LOG=info cargo run

# Debug mode for troubleshooting
MEDIASOUP_LOG_LEVEL=debug RUST_LOG=debug cargo run
```

### Client Debug

Enable **Debug Logging** in module settings for detailed WebRTC connection logs in browser console.

## 🐛 Troubleshooting

### Common Issues

**Connection Failures:**

- Verify server URL and network connectivity
- Check firewall rules for signaling (TCP 3000) and media (UDP 10000-10100)
- Ensure server is running and accessible

**Audio/Video Issues:**

- Check browser permissions for microphone/camera access
- Verify device selection in module settings
- Monitor WebRTC connection states in debug logs

**NAT/Firewall Problems:**

- Set `MEDIASOUP_ANNOUNCED_IP` to your public IP
- Configure port forwarding for RTC port range
- Use STUN/TURN servers for complex network setups

## 📈 Performance Tuning

### Server Optimization

```bash
# Scale workers for CPU cores
MEDIASOUP_NUM_WORKERS=4

# Increase port range for concurrent connections
MEDIASOUP_RTC_MAX_PORT=20000

# System limits
echo "mediasoup soft nofile 65536" >> /etc/security/limits.conf
```

### Client Optimization

- Use Chrome/Chromium for best WebRTC performance
- Enable hardware acceleration in browser settings
- Monitor network quality and adjust video resolution

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Follow development guidelines:
   - Client: Run `just check` (typecheck + build + lint + test)
   - Server: Run `just server-check` (`cargo fmt --check`, `clippy -D warnings`, `cargo test`)
4. Commit with descriptive messages
5. Submit Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [MediaSoup](https://mediasoup.org/) - Powerful WebRTC SFU library
- [FoundryVTT](https://foundryvtt.com/) - Amazing virtual tabletop platform
- Rust and WebRTC communities for excellent tooling and documentation

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/laurigates/foundryvtt-mediasoup-webrtc/issues)
- **Documentation**: [MediaSoup Docs](https://mediasoup.org/documentation/) | [FoundryVTT API](https://foundryvtt.com/api/)
- **Community**: FoundryVTT Discord server

---

**Ready to enhance your FoundryVTT sessions with professional-grade audio/video communication!** 🎲🎬
