use crate::config::{Config, TlsConfig};
use crate::error::{MediaSoupError, Result};
use crate::room::{media_kind_str, Peer, Room};
use crate::signaling::*;
use dashmap::DashMap;
use futures_util::stream::SplitStream;
use futures_util::{SinkExt, StreamExt};
use mediasoup::prelude::*;
use mediasoup::worker_manager::WorkerManager;
use mediasoup::worker::{WorkerLogLevel, WorkerLogTag, WorkerSettings};
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::ServerConfig as RustlsServerConfig;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

/// A stream usable as the transport under a WebSocket connection (plain TCP or
/// a TLS-wrapped TCP stream).
trait IoStream: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> IoStream for T {}

/// Serialize and send a single signaling frame directly over a WebSocket sink
/// (used during the pre-peer authentication handshake).
async fn send_frame(
    ws_sender: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    message: OutgoingMessage,
) -> Result<()> {
    let json = serde_json::to_string(&message)?;
    ws_sender
        .send(Message::Text(json.into()))
        .await
        .map_err(MediaSoupError::from)
}

/// Length-checked, constant-time byte comparison (avoids early-exit timing
/// leaks on the shared secret).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Load a rustls `TlsAcceptor` from PEM certificate-chain and private-key files.
fn load_tls_acceptor(tls: &TlsConfig) -> Result<TlsAcceptor> {
    let cert_bytes = std::fs::read(&tls.cert_path).map_err(|e| {
        MediaSoupError::Config(format!("Failed to read TLS cert {}: {}", tls.cert_path, e))
    })?;
    let key_bytes = std::fs::read(&tls.key_path).map_err(|e| {
        MediaSoupError::Config(format!("Failed to read TLS key {}: {}", tls.key_path, e))
    })?;

    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_bytes.as_slice())
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| MediaSoupError::Config(format!("Invalid TLS certificate: {e}")))?;
    if certs.is_empty() {
        return Err(MediaSoupError::Config(format!(
            "No certificates found in {}",
            tls.cert_path
        )));
    }

    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_bytes.as_slice())
        .map_err(|e| MediaSoupError::Config(format!("Invalid TLS private key: {e}")))?
        .ok_or_else(|| {
            MediaSoupError::Config(format!("No private key found in {}", tls.key_path))
        })?;

    let server_config = RustlsServerConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| MediaSoupError::Config(format!("Failed to select TLS protocol versions: {e}")))?
    .with_no_client_auth()
    .with_single_cert(certs, key)
    .map_err(|e| MediaSoupError::Config(format!("Failed to build TLS config: {e}")))?;

    Ok(TlsAcceptor::from(Arc::new(server_config)))
}

/// Main MediaSoup server
pub struct MediaSoupServer {
    config: Config,
    worker_manager: CustomWorkerManager,
    rooms: Arc<DashMap<String, Arc<Room>>>,
}

impl MediaSoupServer {
    /// Create a new MediaSoup server
    pub async fn new(config: Config) -> Result<Self> {
        let worker_manager = CustomWorkerManager::new(&config).await?;
        
        Ok(Self {
            config,
            worker_manager,
            rooms: Arc::new(DashMap::new()),
        })
    }
    
    /// Run the server
    pub async fn run(self) -> Result<()> {
        let listener = TcpListener::bind(&self.config.listen_addr).await
            .map_err(|e| MediaSoupError::Config(format!("Failed to bind to {}: {}", self.config.listen_addr, e)))?;

        // Build an optional TLS acceptor for native wss:// termination.
        let tls_acceptor = match &self.config.tls {
            Some(tls) => {
                let acceptor = load_tls_acceptor(tls)?;
                info!("Native TLS enabled (wss://) using cert {}", tls.cert_path);
                Some(acceptor)
            }
            None => {
                info!("Native TLS disabled; serving ws:// (terminate TLS at a reverse proxy for browsers)");
                None
            }
        };

        if self.config.auth_token.is_none() {
            warn!(
                "MEDIASOUP_AUTH_TOKEN is not set: the server is UNAUTHENTICATED. \
                 Set a shared secret before exposing it to a network."
            );
        }

        info!("WebSocket server listening on {}", self.config.listen_addr);

        let server = Arc::new(self);

        while let Ok((stream, addr)) = listener.accept().await {
            let server_clone = server.clone();
            let acceptor = tls_acceptor.clone();
            tokio::spawn(async move {
                let result = match acceptor {
                    Some(acceptor) => match acceptor.accept(stream).await {
                        Ok(tls_stream) => server_clone.handle_connection(tls_stream, addr).await,
                        Err(e) => {
                            error!("TLS handshake failed from {}: {}", addr, e);
                            return;
                        }
                    },
                    None => server_clone.handle_connection(stream, addr).await,
                };
                if let Err(e) = result {
                    error!("Error handling connection from {}: {}", addr, e);
                }
            });
        }

        Ok(())
    }

    /// Handle a new WebSocket connection (over plain TCP or TLS).
    async fn handle_connection<S: IoStream>(&self, stream: S, addr: SocketAddr) -> Result<()> {
        info!("New connection from {}", addr);

        let ws_stream = accept_async(stream).await?;
        let (mut ws_sender, mut ws_receiver) = ws_stream.split();

        // Authenticate before allocating any room/peer resources. On failure we
        // reply with an error and drop the connection (see #118).
        let user_id = match self.authenticate(&mut ws_receiver, &mut ws_sender).await {
            Ok(user_id) => user_id,
            Err(e) => {
                warn!("Authentication failed for {}: {}", addr, e);
                return Err(e);
            }
        };

        // Create a channel for sending messages to this peer
        let (message_sender, mut message_receiver) = mpsc::unbounded_channel::<OutgoingMessage>();

        // Identity is the authenticated FoundryVTT user id.
        let peer = Arc::new(Peer::new(user_id, message_sender));

        // Get or create a default room (in production, this would be based on authentication/routing)
        let room_id = "default".to_string();
        let room = self.get_or_create_room(&room_id).await?;

        // Add peer to room
        room.add_peer(peer.clone()).await?;

        let peer_id = peer.id.clone();
        let room_clone = room.clone();

        // Spawn task to handle outgoing messages
        let outgoing_task = {
            tokio::spawn(async move {
                while let Some(message) = message_receiver.recv().await {
                    let json = match serde_json::to_string(&message) {
                        Ok(json) => json,
                        Err(e) => {
                            error!("Failed to serialize message: {}", e);
                            continue;
                        }
                    };

                    if let Err(e) = ws_sender.send(Message::Text(json.into())).await {
                        error!("Failed to send message: {}", e);
                        break;
                    }
                }
            })
        };

        // Handle incoming messages
        let incoming_result = self.handle_incoming_messages(&mut ws_receiver, peer.clone(), room.clone()).await;

        // Cleanup
        outgoing_task.abort();
        if let Err(e) = room_clone.remove_peer(&peer_id).await {
            error!("Failed to remove peer {}: {}", peer_id, e);
        }
        // Release the room (and its router) once the last peer has left.
        self.cleanup_room_if_empty(&room_id);

        info!("Connection from {} closed", addr);
        incoming_result
    }

    /// Perform the authentication handshake. The client's first frame must be an
    /// `authenticate` request carrying the shared `token` (when one is
    /// configured) and `userId`. Returns the authenticated user id.
    ///
    /// This is a deployment-level shared-secret gate (#118). True per-user
    /// FoundryVTT session validation needs a Foundry-side relay to mint signed
    /// per-user tokens; that is tracked as a follow-up. Once such a relay exists,
    /// only `verify_token` below needs to change.
    async fn authenticate<S: IoStream>(
        &self,
        ws_receiver: &mut SplitStream<WebSocketStream<S>>,
        ws_sender: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    ) -> Result<String> {
        while let Some(frame) = ws_receiver.next().await {
            let frame = frame?;
            let text = match frame {
                Message::Text(text) => text,
                Message::Close(_) => {
                    return Err(MediaSoupError::InvalidRequest("Closed before auth".to_string()))
                }
                _ => continue, // ignore pings/binary before auth
            };

            let message: IncomingMessage = serde_json::from_str(&text)?;
            if message.msg_type != "authenticate" {
                let err = "Authentication required: first message must be 'authenticate'";
                if let Some(request_id) = message.request_id.clone() {
                    send_frame(ws_sender, OutgoingMessage::error(request_id, err.to_string())).await?;
                }
                return Err(MediaSoupError::InvalidRequest(err.to_string()));
            }

            let provided = message
                .payload
                .get("token")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if let Err(e) = self.verify_token(provided) {
                if let Some(request_id) = message.request_id.clone() {
                    send_frame(ws_sender, OutgoingMessage::error(request_id, e.to_string())).await?;
                }
                return Err(e);
            }

            // Identity is the client-supplied FoundryVTT user id; fall back to a
            // random id if absent so peers remain distinguishable.
            let user_id = message
                .user_id
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| Uuid::new_v4().to_string());

            if let Some(request_id) = message.request_id.clone() {
                send_frame(ws_sender, OutgoingMessage::response(request_id, serde_json::json!({})))
                    .await?;
            }

            debug!("Authenticated user {}", user_id);
            return Ok(user_id);
        }

        Err(MediaSoupError::InvalidRequest("Connection closed before authentication".to_string()))
    }

    /// Validate a client-provided token against the configured shared secret
    /// using a length-checked, constant-time comparison.
    fn verify_token(&self, provided: &str) -> Result<()> {
        match &self.config.auth_token {
            None => Ok(()), // unauthenticated mode (warned at startup)
            Some(expected) => {
                if constant_time_eq(expected.as_bytes(), provided.as_bytes()) {
                    Ok(())
                } else {
                    Err(MediaSoupError::InvalidRequest("Invalid authentication token".to_string()))
                }
            }
        }
    }

    /// Handle incoming WebSocket messages
    async fn handle_incoming_messages<S: IoStream>(
        &self,
        ws_receiver: &mut SplitStream<WebSocketStream<S>>,
        peer: Arc<Peer>,
        room: Arc<Room>,
    ) -> Result<()> {
        while let Some(message) = ws_receiver.next().await {
            let message = message?;
            
            match message {
                Message::Text(text) => {
                    if let Err(e) = self.handle_signaling_message(&text, &peer, &room).await {
                        error!("Error handling signaling message: {}", e);
                    }
                }
                Message::Close(_) => {
                    debug!("WebSocket connection closed");
                    break;
                }
                _ => {
                    debug!("Received non-text message, ignoring");
                }
            }
        }
        
        Ok(())
    }
    
    /// Handle a signaling message
    async fn handle_signaling_message(
        &self,
        text: &str,
        peer: &Arc<Peer>,
        room: &Arc<Room>,
    ) -> Result<()> {
        let message: IncomingMessage = serde_json::from_str(text)?;
        debug!("Received message: {} from peer {}", message.msg_type, peer.id);

        let result: Result<Value> = match message.msg_type.as_str() {
            // Authentication already happened during the handshake; a stray
            // re-auth is a harmless no-op.
            "authenticate" => Ok(serde_json::json!({})),
            "getRouterRtpCapabilities" => self.handle_get_router_rtp_capabilities(room).await,
            "createWebRtcTransport" => {
                self.handle_create_webrtc_transport(&message, peer, room).await
            }
            "connectTransport" => self.handle_connect_transport(&message, peer).await,
            "produce" => self.handle_produce(&message, peer, room).await,
            "consume" => self.handle_consume(&message, peer, room).await,
            "consumerResume" => self.handle_resume_consumer(&message, peer).await,
            "pauseProducer" => self.handle_pause_producer(&message, peer).await,
            "resumeProducer" => self.handle_resume_producer(&message, peer).await,
            other => Err(MediaSoupError::InvalidRequest(format!("Unknown method: {other}"))),
        };

        // Reply only if the client correlated this with a requestId.
        if let Some(request_id) = message.request_id.clone() {
            let outgoing = match result {
                Ok(data) => OutgoingMessage::response(request_id, data),
                Err(e) => {
                    warn!("Request '{}' failed: {}", message.msg_type, e);
                    OutgoingMessage::error(request_id, e.to_string())
                }
            };
            peer.send_message(outgoing)?;
        } else if let Err(e) = result {
            error!("Error handling '{}' (no requestId): {}", message.msg_type, e);
        }

        Ok(())
    }

    /// Handle getRouterRtpCapabilities request
    async fn handle_get_router_rtp_capabilities(&self, room: &Arc<Room>) -> Result<Value> {
        let capabilities = room.get_rtp_capabilities();
        Ok(serde_json::to_value(capabilities)?)
    }

    /// Handle createWebRtcTransport request
    async fn handle_create_webrtc_transport(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
        room: &Arc<Room>,
    ) -> Result<Value> {
        let data: CreateWebRtcTransportData = serde_json::from_value(message.payload_value())?;

        // Use config listen IPs directly
        let listen_ips = self.config.webrtc.listen_ips.clone();

        let transport = room.create_webrtc_transport(
            &peer.id,
            listen_ips,
            true,  // enable_udp
            true,  // enable_tcp
            true,  // prefer_udp
            data.sctp_capabilities.is_some(), // enable_sctp
        ).await?;

        Ok(serde_json::to_value(TransportCreatedResponse {
            id: transport.id().to_string(),
            ice_parameters: serde_json::to_value(transport.ice_parameters())?,
            ice_candidates: serde_json::to_value(transport.ice_candidates())?,
            dtls_parameters: serde_json::to_value(transport.dtls_parameters())?,
            sctp_parameters: transport.sctp_parameters().map(serde_json::to_value).transpose()?,
        })?)
    }

    /// Handle connectTransport request
    async fn handle_connect_transport(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
    ) -> Result<Value> {
        let data: ConnectTransportData = serde_json::from_value(message.payload_value())?;

        // Clone the (Arc-backed) transport handle and drop the DashMap guard
        // before awaiting, so we never hold a shard lock across `.await`.
        let transport = peer
            .transports
            .get(&data.transport_id)
            .map(|t| t.clone())
            .ok_or_else(|| MediaSoupError::TransportNotFound(data.transport_id.clone()))?;

        let dtls_parameters: DtlsParameters = serde_json::from_value(data.dtls_parameters)?;

        transport.connect(WebRtcTransportRemoteParameters { dtls_parameters }).await
            .map_err(|e| MediaSoupError::Transport(e.to_string()))?;

        Ok(serde_json::json!({}))
    }

    /// Handle produce request
    async fn handle_produce(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
        room: &Arc<Room>,
    ) -> Result<Value> {
        let data: ProduceData = serde_json::from_value(message.payload_value())?;

        let kind = match data.kind.as_str() {
            "audio" => MediaKind::Audio,
            "video" => MediaKind::Video,
            other => return Err(MediaSoupError::InvalidRequest(format!("Invalid media kind: {other}"))),
        };

        let rtp_parameters: RtpParameters = serde_json::from_value(data.rtp_parameters)?;

        let producer = room.create_producer(
            &peer.id,
            &data.transport_id,
            kind,
            rtp_parameters,
            data.app_data,
        ).await?;

        Ok(serde_json::to_value(ProducedResponse {
            id: producer.id().to_string(),
        })?)
    }

    /// Handle consume request
    async fn handle_consume(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
        room: &Arc<Room>,
    ) -> Result<Value> {
        let data: ConsumeData = serde_json::from_value(message.payload_value())?;

        let rtp_capabilities: RtpCapabilities = serde_json::from_value(data.rtp_capabilities)?;

        let consumer = room.create_consumer(
            &peer.id,
            &data.transport_id,
            &data.producer_id,
            rtp_capabilities,
        ).await?;

        Ok(serde_json::to_value(ConsumedResponse {
            id: consumer.id().to_string(),
            producer_id: data.producer_id,
            kind: media_kind_str(consumer.kind()).to_string(),
            rtp_parameters: serde_json::to_value(consumer.rtp_parameters())?,
            producer_paused: consumer.producer_paused(),
        })?)
    }

    /// Handle consumerResume request (resume a consumer created paused)
    async fn handle_resume_consumer(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
    ) -> Result<Value> {
        let consumer_id = message.payload.get("consumerId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| MediaSoupError::InvalidRequest("Missing consumerId".to_string()))?;

        let consumer = peer.consumers.get(consumer_id)
            .map(|c| c.clone())
            .ok_or_else(|| MediaSoupError::ConsumerNotFound(consumer_id.to_string()))?;

        consumer.resume().await
            .map_err(|e| MediaSoupError::Consumer(e.to_string()))?;

        Ok(serde_json::json!({}))
    }

    /// Handle pauseProducer request
    async fn handle_pause_producer(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
    ) -> Result<Value> {
        let producer_id = message.payload.get("producerId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| MediaSoupError::InvalidRequest("Missing producerId".to_string()))?;

        let producer = peer.producers.get(producer_id)
            .map(|p| p.clone())
            .ok_or_else(|| MediaSoupError::ProducerNotFound(producer_id.to_string()))?;

        producer.pause().await
            .map_err(|e| MediaSoupError::Producer(e.to_string()))?;

        Ok(serde_json::json!({}))
    }

    /// Handle resumeProducer request
    async fn handle_resume_producer(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
    ) -> Result<Value> {
        let producer_id = message.payload.get("producerId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| MediaSoupError::InvalidRequest("Missing producerId".to_string()))?;

        let producer = peer.producers.get(producer_id)
            .map(|p| p.clone())
            .ok_or_else(|| MediaSoupError::ProducerNotFound(producer_id.to_string()))?;

        producer.resume().await
            .map_err(|e| MediaSoupError::Producer(e.to_string()))?;

        Ok(serde_json::json!({}))
    }
    
    /// Get or create a room.
    ///
    /// The router is created *before* touching the map so we never hold a
    /// DashMap shard lock across the `.await`. The final insert uses the `entry`
    /// API so two simultaneous first-connections can't both win: the loser drops
    /// its freshly created room (and its router) instead of leaking it (#123).
    async fn get_or_create_room(&self, room_id: &str) -> Result<Arc<Room>> {
        // Fast path: already exists.
        if let Some(room) = self.rooms.get(room_id) {
            return Ok(room.clone());
        }

        // Create the router without holding any lock.
        let worker = self.worker_manager.get_worker().await?;
        let new_room = Arc::new(Room::new(room_id.to_string(), &worker).await?);

        // Insert only if still vacant; otherwise adopt the winner's room.
        use dashmap::mapref::entry::Entry;
        match self.rooms.entry(room_id.to_string()) {
            Entry::Occupied(existing) => Ok(existing.get().clone()),
            Entry::Vacant(slot) => {
                slot.insert(new_room.clone());
                Ok(new_room)
            }
        }
    }

    /// Remove a room once its last peer has left, freeing the mediasoup router.
    /// `remove_if` re-checks emptiness while holding the shard lock, so a peer
    /// joining concurrently keeps the room alive (#123).
    fn cleanup_room_if_empty(&self, room_id: &str) {
        if self.rooms.remove_if(room_id, |_, room| room.is_empty()).is_some() {
            info!("Removed empty room {} (router released)", room_id);
        }
    }
}

/// Worker manager to handle MediaSoup workers
pub struct CustomWorkerManager {
    workers: Vec<Worker>,
    current_worker: std::sync::atomic::AtomicUsize,
    worker_manager: WorkerManager,
}

impl CustomWorkerManager {
    /// Create a new worker manager
    pub async fn new(config: &Config) -> Result<Self> {
        let worker_manager = WorkerManager::new();
        let mut workers = Vec::new();
        
        // Apply configured log level/tags and the RTC port range so workers bind
        // ICE/DTLS/RTP within the firewalled/Docker-mapped range (#123).
        let log_level = Self::parse_log_level(&config.worker.log_level);
        let log_tags: Vec<WorkerLogTag> = config
            .worker
            .log_tags
            .iter()
            .map(|tag| Self::parse_log_tag(tag))
            .collect();
        let rtc_port_range = config.worker.rtc_min_port..=config.worker.rtc_max_port;

        for i in 0..config.worker.num_workers {
            let mut worker_settings = WorkerSettings::default();
            worker_settings.log_level = log_level;
            worker_settings.log_tags = log_tags.clone();
            worker_settings.rtc_port_range = rtc_port_range.clone();

            let worker = worker_manager.create_worker(worker_settings).await?;
            info!(
                "Created MediaSoup worker {} with ID {} (rtc ports {}-{})",
                i,
                worker.id(),
                config.worker.rtc_min_port,
                config.worker.rtc_max_port
            );
            workers.push(worker);
        }
        
        Ok(Self {
            workers,
            current_worker: std::sync::atomic::AtomicUsize::new(0),
            worker_manager,
        })
    }
    
    /// Get a worker (round-robin)
    pub async fn get_worker(&self) -> Result<&Worker> {
        let index = self.current_worker.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % self.workers.len();
        self.workers.get(index).ok_or_else(|| MediaSoupError::Config("No workers available".to_string()))
    }
    
    /// Parse a worker log level from config, defaulting to `Warn`.
    fn parse_log_level(level: &str) -> WorkerLogLevel {
        match level.to_lowercase().as_str() {
            "debug" => WorkerLogLevel::Debug,
            "warn" => WorkerLogLevel::Warn,
            "error" => WorkerLogLevel::Error,
            "none" | "off" => WorkerLogLevel::None,
            _ => WorkerLogLevel::Warn,
        }
    }

    /// Parse a worker log tag from config, defaulting to `Info`.
    fn parse_log_tag(tag: &str) -> WorkerLogTag {
        match tag.to_lowercase().as_str() {
            "info" => WorkerLogTag::Info,
            "ice" => WorkerLogTag::Ice,
            "dtls" => WorkerLogTag::Dtls,
            "rtp" => WorkerLogTag::Rtp,
            "srtp" => WorkerLogTag::Srtp,
            "rtcp" => WorkerLogTag::Rtcp,
            "rtx" => WorkerLogTag::Rtx,
            "bwe" => WorkerLogTag::Bwe,
            "score" => WorkerLogTag::Score,
            "simulcast" => WorkerLogTag::Simulcast,
            "svc" => WorkerLogTag::Svc,
            "sctp" => WorkerLogTag::Sctp,
            "message" => WorkerLogTag::Message,
            _ => WorkerLogTag::Info,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn constant_time_eq_matches_identical_secrets() {
        assert!(constant_time_eq(b"s3cret-token", b"s3cret-token"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn constant_time_eq_rejects_mismatches_and_length_differences() {
        assert!(!constant_time_eq(b"s3cret-token", b"wrong-token!"));
        assert!(!constant_time_eq(b"short", b"longer-secret"));
        assert!(!constant_time_eq(b"token", b""));
    }
}
