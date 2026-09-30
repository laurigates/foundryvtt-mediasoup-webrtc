use crate::error::MediaSoupError;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use tracing::warn;

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
    /// Listen IPs for WebRTC transports. Each one gets a UDP and/or a TCP
    /// `ListenInfo` depending on `enable_udp` / `enable_tcp`.
    pub listen_ips: Vec<ListenIp>,

    /// Offer UDP ICE candidates (`MEDIASOUP_ENABLE_UDP`, default on).
    #[serde(default = "default_true")]
    pub enable_udp: bool,

    /// Offer TCP ICE candidates (`MEDIASOUP_ENABLE_TCP`, default on). TCP lets
    /// clients behind UDP-blocking firewalls still connect.
    #[serde(default = "default_true")]
    pub enable_tcp: bool,

    /// Give UDP candidates a higher ICE priority than TCP
    /// (`MEDIASOUP_PREFER_UDP`, default on).
    #[serde(default = "default_true")]
    pub prefer_udp: bool,

    /// Permit a wildcard listen IP (`0.0.0.0` / `::`) without an announced IP
    /// (`MEDIASOUP_ALLOW_UNANNOUNCED=1`). Such a server advertises an
    /// unroutable ICE candidate, so this only makes sense for local testing.
    #[serde(default)]
    pub allow_unannounced: bool,
}

fn default_true() -> bool {
    true
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
                    ip: non_empty_env("MEDIASOUP_LISTEN_IP")
                        .unwrap_or_else(|| "0.0.0.0".to_string()),
                    // An empty value (e.g. `MEDIASOUP_ANNOUNCED_IP=` in a
                    // compose file) means "unset", not "announce ''".
                    announced_ip: non_empty_env("MEDIASOUP_ANNOUNCED_IP"),
                }],
                enable_udp: env_flag("MEDIASOUP_ENABLE_UDP", true),
                enable_tcp: env_flag("MEDIASOUP_ENABLE_TCP", true),
                prefer_udp: env_flag("MEDIASOUP_PREFER_UDP", true),
                allow_unannounced: env_flag("MEDIASOUP_ALLOW_UNANNOUNCED", false),
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

    /// Check the configuration for settings that would start a server that
    /// cannot carry media. Returns an error for fatal problems; logs a warning
    /// for risky-but-allowed ones.
    ///
    /// The main check: a wildcard listen IP (`0.0.0.0` / `::`) with no
    /// announced IP makes mediasoup advertise the wildcard itself as the ICE
    /// candidate, which no browser can reach, so no audio/video ever flows.
    /// That is an error unless `MEDIASOUP_ALLOW_UNANNOUNCED=1` is set.
    pub fn validate(&self) -> crate::error::Result<()> {
        let webrtc = &self.webrtc;

        if webrtc.listen_ips.is_empty() {
            return Err(MediaSoupError::Config(
                "No WebRTC listen IPs configured".to_string(),
            ));
        }
        if !webrtc.enable_udp && !webrtc.enable_tcp {
            return Err(MediaSoupError::Config(
                "Both MEDIASOUP_ENABLE_UDP and MEDIASOUP_ENABLE_TCP are disabled; \
                 WebRTC transports need at least one"
                    .to_string(),
            ));
        }
        if self.worker.rtc_min_port > self.worker.rtc_max_port {
            return Err(MediaSoupError::Config(format!(
                "MEDIASOUP_RTC_MIN_PORT ({}) is greater than MEDIASOUP_RTC_MAX_PORT ({})",
                self.worker.rtc_min_port, self.worker.rtc_max_port
            )));
        }

        for listen_ip in &webrtc.listen_ips {
            let ip: IpAddr = listen_ip.ip.parse().map_err(|_| {
                MediaSoupError::Config(format!(
                    "Invalid WebRTC listen IP '{}' (MEDIASOUP_LISTEN_IP)",
                    listen_ip.ip
                ))
            })?;

            if ip.is_unspecified() && listen_ip.announced_ip.is_none() {
                let msg = format!(
                    "WebRTC listen IP is {ip} but MEDIASOUP_ANNOUNCED_IP is not set: \
                     clients would be sent an unroutable {ip} ICE candidate and no \
                     media would flow. Set MEDIASOUP_ANNOUNCED_IP to the address \
                     clients reach this host on, or set MEDIASOUP_LISTEN_IP to a \
                     concrete interface address"
                );
                if webrtc.allow_unannounced {
                    warn!("{msg} (allowed by MEDIASOUP_ALLOW_UNANNOUNCED=1)");
                } else {
                    return Err(MediaSoupError::Config(format!(
                        "{msg} (or set MEDIASOUP_ALLOW_UNANNOUNCED=1 to start anyway)"
                    )));
                }
            }
        }

        Ok(())
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

/// Read an environment variable, treating an empty (or whitespace-only) value
/// as unset.
fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Read a boolean environment flag (`1`/`true`/`yes`/`on` or
/// `0`/`false`/`no`/`off`, case-insensitive), falling back to `default` when
/// unset, empty or unrecognised.
fn env_flag(name: &str, default: bool) -> bool {
    parse_flag(non_empty_env(name).as_deref(), default)
}

fn parse_flag(value: Option<&str>, default: bool) -> bool {
    match value.map(str::to_ascii_lowercase).as_deref() {
        Some("1" | "true" | "yes" | "on") => true,
        Some("0" | "false" | "no" | "off") => false,
        _ => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with(ip: &str, announced_ip: Option<&str>, allow_unannounced: bool) -> Config {
        Config {
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            http_addr: None,
            worker: WorkerConfig {
                num_workers: 1,
                log_level: "warn".to_string(),
                log_tags: vec![],
                rtc_min_port: 10000,
                rtc_max_port: 10100,
            },
            router: RouterConfig {
                media_codecs: vec![],
            },
            webrtc: WebRtcConfig {
                listen_ips: vec![ListenIp {
                    ip: ip.to_string(),
                    announced_ip: announced_ip.map(str::to_string),
                }],
                enable_udp: true,
                enable_tcp: true,
                prefer_udp: true,
                allow_unannounced,
            },
            auth_token: None,
            tls: None,
        }
    }

    fn is_config_err(result: crate::error::Result<()>) -> bool {
        matches!(result, Err(MediaSoupError::Config(_)))
    }

    /// The validate() matrix: wildcard IPs need an announced IP unless the
    /// override is set; concrete IPs are always fine.
    #[test]
    fn validate_matrix() {
        // (listen ip, announced ip, allow_unannounced, expect ok)
        let cases = [
            ("0.0.0.0", None, false, false),
            ("::", None, false, false),
            ("0.0.0.0", None, true, true),
            ("::", None, true, true),
            ("0.0.0.0", Some("203.0.113.7"), false, true),
            ("::", Some("2001:db8::1"), false, true),
            ("0.0.0.0", Some("sfu.example.com"), false, true),
            ("127.0.0.1", None, false, true),
            ("192.168.1.10", None, false, true),
            ("192.168.1.10", Some("203.0.113.7"), false, true),
            ("not-an-ip", None, false, false),
            ("not-an-ip", None, true, false),
            ("", Some("203.0.113.7"), false, false),
        ];
        for (ip, announced, allow, expect_ok) in cases {
            let result = config_with(ip, announced, allow).validate();
            if expect_ok {
                assert!(
                    result.is_ok(),
                    "{ip:?}/{announced:?}/allow={allow}: expected Ok, got {result:?}"
                );
            } else {
                assert!(
                    is_config_err(result),
                    "{ip:?}/{announced:?}/allow={allow}: expected a Config error"
                );
            }
        }
    }

    #[test]
    fn validate_rejects_no_protocols_no_ips_and_inverted_port_range() {
        let mut config = config_with("127.0.0.1", None, false);
        config.webrtc.enable_udp = false;
        config.webrtc.enable_tcp = false;
        assert!(is_config_err(config.validate()));

        let mut config = config_with("127.0.0.1", None, false);
        config.webrtc.enable_udp = false;
        assert!(config.validate().is_ok(), "TCP-only is valid");

        let mut config = config_with("127.0.0.1", None, false);
        config.webrtc.listen_ips.clear();
        assert!(is_config_err(config.validate()));

        let mut config = config_with("127.0.0.1", None, false);
        config.worker.rtc_min_port = 20000;
        config.worker.rtc_max_port = 10000;
        assert!(is_config_err(config.validate()));
    }

    #[test]
    fn parse_flag_accepts_common_spellings() {
        for on in ["1", "true", "TRUE", "yes", "On"] {
            assert!(parse_flag(Some(on), false), "{on}");
        }
        for off in ["0", "false", "No", "OFF"] {
            assert!(!parse_flag(Some(off), true), "{off}");
        }
        assert!(parse_flag(None, true));
        assert!(!parse_flag(None, false));
        assert!(parse_flag(Some("garbage"), true));
    }
}
