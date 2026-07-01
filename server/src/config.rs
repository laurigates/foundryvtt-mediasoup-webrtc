use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;

/// Server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Address to listen on for WebSocket connections
    pub listen_addr: SocketAddr,

    /// HTTP server address for serving static files (optional)
    pub http_addr: Option<SocketAddr>,

    /// MediaSoup worker settings
    pub worker: WorkerConfig,

    /// Router settings
    pub router: RouterConfig,

    /// WebRTC transport settings
    pub webrtc: WebRtcConfig,

    /// Shared secret required from clients to connect. When `None`, the server
    /// runs unauthenticated (development only) and logs a warning. See #118.
    pub auth_token: Option<String>,

    /// Optional native TLS termination. When set, the server accepts `wss://`
    /// directly; when `None`, it serves plain `ws://` and expects TLS to be
    /// terminated by a reverse proxy.
    pub tls: Option<TlsConfig>,
}

/// Paths to the PEM-encoded certificate chain and private key for native TLS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlsConfig {
    pub cert_path: String,
    pub key_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerConfig {
    /// Number of worker processes to spawn
    pub num_workers: usize,

    /// Log level for MediaSoup worker
    pub log_level: String,

    /// Log tags to enable
    pub log_tags: Vec<String>,

    /// RTC port range for UDP/TCP
    pub rtc_min_port: u16,
    pub rtc_max_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouterConfig {
    /// Media codecs to support
    pub media_codecs: Vec<MediaCodec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaCodec {
    pub kind: String,
    pub mime_type: String,
    pub clock_rate: u32,
    pub channels: Option<u8>,
    pub parameters: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebRtcConfig {
    /// Listen IPs for WebRTC transports
    pub listen_ips: Vec<ListenIp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListenIp {
    pub ip: String,
    pub announced_ip: Option<String>,
}

impl Config {
    /// Load configuration from environment variables and defaults
    pub fn load() -> Result<Self> {
        let config = Config {
            listen_addr: std::env::var("MEDIASOUP_LISTEN_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:3000".to_string())
                .parse()?,

            http_addr: std::env::var("MEDIASOUP_HTTP_ADDR")
                .ok()
                .map(|addr| addr.parse())
                .transpose()?,

            worker: WorkerConfig {
                num_workers: std::env::var("MEDIASOUP_NUM_WORKERS")
                    .unwrap_or_else(|_| "1".to_string())
                    .parse()
                    .unwrap_or(1),

                log_level: std::env::var("MEDIASOUP_LOG_LEVEL")
                    .unwrap_or_else(|_| "warn".to_string()),

                log_tags: std::env::var("MEDIASOUP_LOG_TAGS")
                    .unwrap_or_else(|_| "info".to_string())
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .collect(),

                rtc_min_port: std::env::var("MEDIASOUP_RTC_MIN_PORT")
                    .unwrap_or_else(|_| "10000".to_string())
                    .parse()
                    .unwrap_or(10000),

                rtc_max_port: std::env::var("MEDIASOUP_RTC_MAX_PORT")
                    .unwrap_or_else(|_| "10100".to_string())
                    .parse()
                    .unwrap_or(10100),
            },

            router: RouterConfig {
                media_codecs: Self::default_media_codecs(),
            },

            webrtc: WebRtcConfig {
                listen_ips: vec![ListenIp {
                    ip: "0.0.0.0".to_string(),
                    announced_ip: std::env::var("MEDIASOUP_ANNOUNCED_IP").ok(),
                }],
            },

            auth_token: std::env::var("MEDIASOUP_AUTH_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),

            tls: match (
                std::env::var("MEDIASOUP_TLS_CERT")
                    .ok()
                    .filter(|s| !s.is_empty()),
                std::env::var("MEDIASOUP_TLS_KEY")
                    .ok()
                    .filter(|s| !s.is_empty()),
            ) {
                (Some(cert_path), Some(key_path)) => Some(TlsConfig {
                    cert_path,
                    key_path,
                }),
                _ => None,
            },
        };

        Ok(config)
    }

    /// Default media codecs for FoundryVTT compatibility
    fn default_media_codecs() -> Vec<MediaCodec> {
        vec![
            // Audio codecs
            MediaCodec {
                kind: "audio".to_string(),
                mime_type: "audio/opus".to_string(),
                clock_rate: 48000,
                channels: Some(2),
                parameters: None,
            },
            // Video codecs
            MediaCodec {
                kind: "video".to_string(),
                mime_type: "video/VP8".to_string(),
                clock_rate: 90000,
                channels: None,
                parameters: None,
            },
            MediaCodec {
                kind: "video".to_string(),
                mime_type: "video/VP9".to_string(),
                clock_rate: 90000,
                channels: None,
                parameters: Some(serde_json::json!({
                    "profile-id": 2
                })),
            },
            MediaCodec {
                kind: "video".to_string(),
                mime_type: "video/h264".to_string(),
                clock_rate: 90000,
                channels: None,
                parameters: Some(serde_json::json!({
                    "packetization-mode": 1,
                    "profile-level-id": "4d0032",
                    "level-asymmetry-allowed": 1
                })),
            },
        ]
    }
}
