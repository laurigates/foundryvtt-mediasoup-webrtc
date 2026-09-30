use crate::config::{Config, TlsConfig};
use crate::error::{MediaSoupError, Result};
use crate::room::{CloseRequest, Peer, Room, TransportListenOptions, media_kind_str};
use crate::signaling::*;
use dashmap::DashMap;
use futures_util::stream::SplitStream;
use futures_util::{SinkExt, StreamExt};
use mediasoup::prelude::*;
use mediasoup::worker::{WorkerLogLevel, WorkerLogTag, WorkerSettings};
use mediasoup::worker_manager::WorkerManager;
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, MissedTickBehavior};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::ServerConfig as RustlsServerConfig;
use tokio_rustls::rustls::pki_types::pem::{self, PemObject};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

/// Default interval between server-sent WebSocket pings.
pub const DEFAULT_PING_INTERVAL: Duration = Duration::from_secs(15);

/// Default number of consecutive pings without any inbound frame (pong or
/// otherwise) after which a peer is considered dead and dropped.
pub const DEFAULT_MAX_MISSED_PONGS: u32 = 3;

/// How long a new connection may take to send its `authenticate` frame.
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for the outgoing task to flush a close frame.
const CLOSE_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

/// Room used when a client authenticates without a `roomId`.
pub const DEFAULT_ROOM_ID: &str = "default";

/// Longest accepted `roomId` (Foundry world ids are short slugs).
const MAX_ROOM_ID_LEN: usize = 256;

/// Longest accepted `sessionId`.
const MAX_SESSION_ID_LEN: usize = 128;

/// Identity established by the `authenticate` handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AuthInfo {
    user_id: String,
    room_id: String,
    /// The client's per-page session id, if it sent one.
    session_id: Option<String>,
    /// The client is re-joining after a connection loss (its backoff loop),
    /// not starting a new session.
    reconnect: bool,
    /// The `authenticate` request to answer once the peer has joined its room.
    request_id: Option<String>,
}

/// Read a required string field from a request's payload.
fn required_str<'a>(message: &'a IncomingMessage, field: &str) -> Result<&'a str> {
    message
        .payload
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| MediaSoupError::InvalidRequest(format!("Missing {field}")))
}

/// Extract the room id from an `authenticate` frame. Absent or `null` means
/// the default room; anything else must be a non-empty string of bounded
/// length.
fn room_id_from_auth(message: &IncomingMessage) -> Result<String> {
    match message.payload.get("roomId") {
        None | Some(Value::Null) => Ok(DEFAULT_ROOM_ID.to_string()),
        Some(Value::String(id)) if !id.is_empty() && id.len() <= MAX_ROOM_ID_LEN => Ok(id.clone()),
        Some(_) => Err(MediaSoupError::InvalidRequest(format!(
            "Invalid roomId: expected a non-empty string of at most {MAX_ROOM_ID_LEN} bytes"
        ))),
    }
}

/// Extract the optional `sessionId` from an `authenticate` frame. Anything but
/// a non-empty string of bounded length counts as absent.
fn session_id_from_auth(message: &IncomingMessage) -> Option<String> {
    match message.payload.get("sessionId") {
        Some(Value::String(id)) if !id.is_empty() && id.len() <= MAX_SESSION_ID_LEN => {
            Some(id.clone())
        }
        _ => None,
    }
}

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

    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(&cert_bytes)
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| MediaSoupError::Config(format!("Invalid TLS certificate: {e}")))?;
    if certs.is_empty() {
        return Err(MediaSoupError::Config(format!(
            "No certificates found in {}",
            tls.cert_path
        )));
    }

    let key: PrivateKeyDer<'static> =
        PrivateKeyDer::from_pem_slice(&key_bytes).map_err(|e| match e {
            pem::Error::NoItemsFound => {
                MediaSoupError::Config(format!("No private key found in {}", tls.key_path))
            }
            e => MediaSoupError::Config(format!("Invalid TLS private key: {e}")),
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
    ping_interval: Duration,
    max_missed_pongs: u32,
}

impl MediaSoupServer {
    /// Create a new MediaSoup server
    pub async fn new(config: Config) -> Result<Self> {
        let worker_manager = CustomWorkerManager::new(&config).await?;

        Ok(Self {
            config,
            worker_manager,
            rooms: Arc::new(DashMap::new()),
            ping_interval: DEFAULT_PING_INTERVAL,
            max_missed_pongs: DEFAULT_MAX_MISSED_PONGS,
        })
    }

    /// Override the WebSocket keepalive: a ping every `interval`, and the peer
    /// is dropped after `max_missed` consecutive pings with no inbound frame.
    /// Defaults are [`DEFAULT_PING_INTERVAL`] and [`DEFAULT_MAX_MISSED_PONGS`].
    pub fn with_keepalive(mut self, interval: Duration, max_missed: u32) -> Self {
        self.ping_interval = interval;
        self.max_missed_pongs = max_missed.max(1);
        self
    }

    /// Bind `config.listen_addr` and run the server
    pub async fn run(self) -> Result<()> {
        let listener = TcpListener::bind(&self.config.listen_addr)
            .await
            .map_err(|e| {
                MediaSoupError::Config(format!(
                    "Failed to bind to {}: {}",
                    self.config.listen_addr, e
                ))
            })?;
        self.run_with_listener(listener).await
    }

    /// Run the server on an already-bound listener (lets callers bind port 0
    /// and read the chosen address first, e.g. in tests).
    pub async fn run_with_listener(self, listener: TcpListener) -> Result<()> {
        // Build an optional TLS acceptor for native wss:// termination.
        let tls_acceptor = match &self.config.tls {
            Some(tls) => {
                let acceptor = load_tls_acceptor(tls)?;
                info!("Native TLS enabled (wss://) using cert {}", tls.cert_path);
                Some(acceptor)
            }
            None => {
                info!(
                    "Native TLS disabled; serving ws:// (terminate TLS at a reverse proxy for browsers)"
                );
                None
            }
        };

        if self.config.auth_token.is_none() {
            warn!(
                "MEDIASOUP_AUTH_TOKEN is not set: the server is UNAUTHENTICATED. \
                 Set a shared secret before exposing it to a network."
            );
        }

        let local_addr = listener
            .local_addr()
            .map(|a| a.to_string())
            .unwrap_or_else(|_| self.config.listen_addr.to_string());
        info!("WebSocket server listening on {}", local_addr);

        let server = Arc::new(self);

        loop {
            let (stream, addr) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(e) => {
                    // Transient (e.g. EMFILE): keep serving instead of exiting.
                    error!("Failed to accept connection: {}", e);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
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
    }

    /// Handle a new WebSocket connection (over plain TCP or TLS).
    async fn handle_connection<S: IoStream>(&self, stream: S, addr: SocketAddr) -> Result<()> {
        info!("New connection from {}", addr);

        let ws_stream = accept_async(stream).await?;
        let (mut ws_sender, mut ws_receiver) = ws_stream.split();

        // Authenticate before allocating any room/peer resources. On failure we
        // reply with an error and drop the connection (see #118).
        let auth = match tokio::time::timeout(
            AUTH_TIMEOUT,
            self.authenticate(&mut ws_receiver, &mut ws_sender),
        )
        .await
        {
            Ok(Ok(auth)) => auth,
            Ok(Err(e)) => {
                warn!("Authentication failed for {}: {}", addr, e);
                return Err(e);
            }
            Err(_) => {
                warn!("Authentication timed out for {}", addr);
                return Err(MediaSoupError::InvalidRequest(
                    "Authentication timed out".to_string(),
                ));
            }
        };
        let AuthInfo {
            user_id,
            room_id,
            session_id,
            reconnect,
            request_id,
        } = auth;

        // Create a channel for sending messages to this peer
        let (message_sender, mut message_receiver) = mpsc::unbounded_channel::<OutgoingMessage>();

        // Identity is the client-supplied FoundryVTT user id (see `authenticate`).
        let peer = Arc::new(Peer::with_session(user_id, session_id, message_sender));
        let peer_id = peer.id.clone();

        // Join the room named by the client (one router per room, i.e. per
        // Foundry world). If the room is released between the lookup and the
        // join (its last peer left concurrently), we would be stranded in an
        // orphan router nobody else can reach, so retry with a fresh room.
        let joined = loop {
            let room = match self.get_or_create_room(&room_id).await {
                Ok(room) => room,
                Err(e) => break Err(e),
            };
            if let Err(e) = room.join_peer(peer.clone(), reconnect) {
                break Err(e);
            }
            let still_current = self
                .rooms
                .get(&room_id)
                .is_some_and(|current| Arc::ptr_eq(current.value(), &room));
            if still_current {
                break Ok(room);
            }
            room.remove_peer(&peer_id);
        };

        // Answer `authenticate` only now, so a refused join is reported to the
        // client as a failed authenticate. This is sent before the outgoing
        // task starts, so it precedes any notification queued since the join.
        let reply = match &joined {
            Ok(_) => request_id.map(|id| OutgoingMessage::response(id, serde_json::json!({}))),
            Err(e) => request_id.map(|id| OutgoingMessage::error(id, e.to_string())),
        };
        let replied = match reply {
            Some(reply) => send_frame(&mut ws_sender, reply).await,
            None => Ok(()),
        };
        let room = match (joined, replied) {
            (Ok(room), Ok(())) => room,
            (Ok(room), Err(e)) => {
                room.remove_peer(&peer_id);
                self.cleanup_room_if_empty(&room_id);
                return Err(e);
            }
            (Err(e), _) => {
                warn!("{} could not join room {}: {}", addr, room_id, e);
                self.cleanup_room_if_empty(&room_id);
                return Err(e);
            }
        };

        // Keepalive: the outgoing task pings every `ping_interval`; any inbound
        // frame (a pong, or anything else) resets the counter.
        let missed_pongs = Arc::new(AtomicU32::new(0));
        let (close_tx, mut close_rx) = oneshot::channel::<Option<CloseRequest>>();

        // Spawn task to handle outgoing messages
        let mut outgoing_task = {
            let peer = peer.clone();
            let missed_pongs = missed_pongs.clone();
            let ping_interval = self.ping_interval;
            let max_missed = self.max_missed_pongs;
            tokio::spawn(async move {
                let mut ticker =
                    tokio::time::interval_at(Instant::now() + ping_interval, ping_interval);
                ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
                loop {
                    tokio::select! {
                        biased;
                        close = &mut close_rx => {
                            if let Ok(Some(request)) = close {
                                let frame = CloseFrame {
                                    code: CloseCode::from(request.code),
                                    reason: request.reason.into(),
                                };
                                let _ = ws_sender.send(Message::Close(Some(frame))).await;
                            }
                            let _ = ws_sender.close().await;
                            break;
                        }
                        message = message_receiver.recv() => {
                            let Some(message) = message else { break };
                            let json = match serde_json::to_string(&message) {
                                Ok(json) => json,
                                Err(e) => {
                                    error!("Failed to serialize message: {}", e);
                                    continue;
                                }
                            };
                            if let Err(e) = ws_sender.send(Message::Text(json.into())).await {
                                error!("Failed to send message: {}", e);
                                peer.request_shutdown(None);
                                break;
                            }
                        }
                        _ = ticker.tick() => {
                            if missed_pongs.fetch_add(1, Ordering::SeqCst) >= max_missed {
                                warn!(
                                    "Peer {} missed {} pings; dropping connection",
                                    peer.id, max_missed
                                );
                                peer.request_shutdown(None);
                                break;
                            }
                            if ws_sender.send(Message::Ping(Default::default())).await.is_err() {
                                peer.request_shutdown(None);
                                break;
                            }
                        }
                    }
                }
            })
        };

        // Handle incoming messages
        let incoming_result = self
            .handle_incoming_messages(&mut ws_receiver, &peer, &room, &missed_pongs)
            .await;

        // Cleanup: leave the room first so the other peers hear about our
        // producers closing, then flush a close frame if one was requested
        // (e.g. we were evicted by a newer connection of the same user).
        room.remove_peer(&peer_id);
        let _ = close_tx.send(peer.take_close_request());
        if tokio::time::timeout(CLOSE_FLUSH_TIMEOUT, &mut outgoing_task)
            .await
            .is_err()
        {
            outgoing_task.abort();
        }
        // Release the room (and its router) once the last peer has left.
        self.cleanup_room_if_empty(&room_id);

        info!("Connection from {} closed", addr);
        incoming_result
    }

    /// Perform the authentication handshake. The client's first frame must be an
    /// `authenticate` request carrying the shared `token` (when one is
    /// configured), `userId` and `roomId`. Returns the authenticated identity.
    ///
    /// This is a deployment-level shared-secret gate (#118). True per-user
    /// FoundryVTT session validation needs a Foundry-side relay to mint signed
    /// per-user tokens; that is tracked as a follow-up. Once such a relay exists,
    /// only `verify_token` below needs to change.
    async fn authenticate<S: IoStream>(
        &self,
        ws_receiver: &mut SplitStream<WebSocketStream<S>>,
        ws_sender: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    ) -> Result<AuthInfo> {
        while let Some(frame) = ws_receiver.next().await {
            let frame = frame?;
            let text = match frame {
                Message::Text(text) => text,
                Message::Close(_) => {
                    return Err(MediaSoupError::InvalidRequest(
                        "Closed before auth".to_string(),
                    ));
                }
                _ => continue, // ignore pings/binary before auth
            };

            let message = match IncomingMessage::parse(&text) {
                Ok(message) => message,
                Err(e) => {
                    send_frame(
                        ws_sender,
                        OutgoingMessage::error_reply(e.request_id, e.error.clone()),
                    )
                    .await?;
                    return Err(MediaSoupError::InvalidRequest(e.error));
                }
            };

            if message.msg_type != "authenticate" {
                let err = "Authentication required: first message must be 'authenticate'";
                if let Some(request_id) = message.request_id.clone() {
                    send_frame(
                        ws_sender,
                        OutgoingMessage::error(request_id, err.to_string()),
                    )
                    .await?;
                }
                return Err(MediaSoupError::InvalidRequest(err.to_string()));
            }

            let provided = message
                .payload
                .get("token")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let checked = self
                .verify_token(provided)
                .and_then(|()| room_id_from_auth(&message));
            let room_id = match checked {
                Ok(room_id) => room_id,
                Err(e) => {
                    if let Some(request_id) = message.request_id.clone() {
                        send_frame(ws_sender, OutgoingMessage::error(request_id, e.to_string()))
                            .await?;
                    }
                    return Err(e);
                }
            };

            // Identity is the client-supplied FoundryVTT user id; fall back to a
            // random id if absent so peers remain distinguishable. It is NOT
            // authenticated: anyone holding the shared token can claim any
            // user id, and so (see `Room::join_peer`) replace that user's
            // connection. Per-user tokens are the fix (see above).
            let user_id = message
                .user_id
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let session_id = session_id_from_auth(&message);
            let reconnect = message
                .payload
                .get("reconnect")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            // The success reply is sent by the caller once the peer has joined
            // its room, since the join itself can still be refused.
            debug!("Authenticated user {} for room {}", user_id, room_id);
            return Ok(AuthInfo {
                user_id,
                room_id,
                session_id,
                reconnect,
                request_id: message.request_id.clone(),
            });
        }

        Err(MediaSoupError::InvalidRequest(
            "Connection closed before authentication".to_string(),
        ))
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
                    Err(MediaSoupError::InvalidRequest(
                        "Invalid authentication token".to_string(),
                    ))
                }
            }
        }
    }

    /// Handle incoming WebSocket messages until the client closes, the socket
    /// errors, or the peer is asked to shut down (eviction, ping timeout).
    async fn handle_incoming_messages<S: IoStream>(
        &self,
        ws_receiver: &mut SplitStream<WebSocketStream<S>>,
        peer: &Arc<Peer>,
        room: &Arc<Room>,
        missed_pongs: &AtomicU32,
    ) -> Result<()> {
        loop {
            let frame = tokio::select! {
                frame = ws_receiver.next() => frame,
                () = peer.shutdown_requested() => {
                    debug!("Peer {} shutdown requested", peer.id);
                    break;
                }
            };
            let Some(frame) = frame else { break };
            let frame = frame?;
            // Any inbound frame proves the client is alive.
            missed_pongs.store(0, Ordering::SeqCst);

            match frame {
                Message::Text(text) => {
                    if let Err(e) = self.handle_signaling_message(&text, peer, room).await {
                        error!("Error handling signaling message: {}", e);
                    }
                }
                Message::Close(_) => {
                    debug!("WebSocket connection closed");
                    break;
                }
                _ => {
                    // Pongs (and pings, which tungstenite answers itself).
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
        // Parse to a generic value first so a malformed frame still gets an
        // error reply (carrying its requestId when it has one) instead of
        // leaving the client's request pending until it times out.
        let message = match IncomingMessage::parse(text) {
            Ok(message) => message,
            Err(e) => {
                warn!("Malformed frame from peer {}: {}", peer.id, e.error);
                return peer.send_message(OutgoingMessage::error_reply(e.request_id, e.error));
            }
        };
        debug!(
            "Received message: {} from peer {}",
            message.msg_type, peer.id
        );

        let result: Result<Value> = match message.msg_type.as_str() {
            // Authentication already happened during the handshake; a stray
            // re-auth is a harmless no-op.
            "authenticate" => Ok(serde_json::json!({})),
            "getRouterRtpCapabilities" => self.handle_get_router_rtp_capabilities(room).await,
            "createWebRtcTransport" => {
                self.handle_create_webrtc_transport(&message, peer, room)
                    .await
            }
            "connectTransport" => self.handle_connect_transport(&message, peer).await,
            "restartIce" => self.handle_restart_ice(&message, peer, room).await,
            "produce" => self.handle_produce(&message, peer, room).await,
            "getProducers" => self.handle_get_producers(peer, room),
            "closeProducer" => self.handle_close_producer(&message, peer, room),
            "consume" => self.handle_consume(&message, peer, room).await,
            "consumerResume" => self.handle_resume_consumer(&message, peer).await,
            "closeConsumer" => self.handle_close_consumer(&message, peer, room),
            "pauseProducer" => self.handle_pause_producer(&message, peer).await,
            "resumeProducer" => self.handle_resume_producer(&message, peer).await,
            other => Err(MediaSoupError::InvalidRequest(format!(
                "Unknown method: {other}"
            ))),
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
            error!(
                "Error handling '{}' (no requestId): {}",
                message.msg_type, e
            );
        }

        Ok(())
    }

    /// Handle getProducers: every producer in the room except the caller's.
    fn handle_get_producers(&self, peer: &Arc<Peer>, room: &Arc<Room>) -> Result<Value> {
        Ok(serde_json::to_value(ProducersResponse {
            producers: room.list_producers_except(&peer.id),
        })?)
    }

    /// Handle closeProducer: close one of the caller's own producers and
    /// broadcast `producerClosed` to the other peers.
    fn handle_close_producer(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
        room: &Arc<Room>,
    ) -> Result<Value> {
        let producer_id = required_str(message, "producerId")?;
        room.close_producer(&peer.id, producer_id)?;
        Ok(serde_json::json!({}))
    }

    /// Handle closeConsumer: close one of the caller's own consumers.
    fn handle_close_consumer(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
        room: &Arc<Room>,
    ) -> Result<Value> {
        let consumer_id = required_str(message, "consumerId")?;
        room.close_consumer(&peer.id, consumer_id)?;
        Ok(serde_json::json!({}))
    }

    /// Handle restartIce: new ICE parameters for one of the caller's transports.
    async fn handle_restart_ice(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
        room: &Arc<Room>,
    ) -> Result<Value> {
        let transport_id = required_str(message, "transportId")?;
        let ice_parameters = room.restart_ice(&peer.id, transport_id).await?;
        Ok(serde_json::to_value(RestartIceResponse {
            ice_parameters: serde_json::to_value(ice_parameters)?,
        })?)
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

        let webrtc = &self.config.webrtc;
        let listen = TransportListenOptions {
            listen_ips: webrtc.listen_ips.clone(),
            enable_udp: webrtc.enable_udp,
            enable_tcp: webrtc.enable_tcp,
            prefer_udp: webrtc.prefer_udp,
            enable_sctp: data.sctp_capabilities.is_some(),
            // Keep every ICE/DTLS socket inside the firewalled/Docker-mapped
            // range (#123).
            port_range: Some(self.config.worker.rtc_min_port..=self.config.worker.rtc_max_port),
        };

        let transport = room.create_webrtc_transport(&peer.id, &listen).await?;

        Ok(serde_json::to_value(TransportCreatedResponse {
            id: transport.id().to_string(),
            ice_parameters: serde_json::to_value(transport.ice_parameters())?,
            ice_candidates: serde_json::to_value(transport.ice_candidates())?,
            dtls_parameters: serde_json::to_value(transport.dtls_parameters())?,
            sctp_parameters: transport
                .sctp_parameters()
                .map(serde_json::to_value)
                .transpose()?,
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

        transport
            .connect(WebRtcTransportRemoteParameters { dtls_parameters })
            .await
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
        let paused = data.paused;

        let kind = match data.kind.as_str() {
            "audio" => MediaKind::Audio,
            "video" => MediaKind::Video,
            other => {
                return Err(MediaSoupError::InvalidRequest(format!(
                    "Invalid media kind: {other}"
                )));
            }
        };

        let rtp_parameters: RtpParameters = serde_json::from_value(data.rtp_parameters)?;

        let producer = room
            .create_producer(
                &peer.id,
                &data.transport_id,
                kind,
                rtp_parameters,
                data.app_data,
                paused,
            )
            .await?;

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

        let consumer = room
            .create_consumer(
                &peer.id,
                &data.transport_id,
                &data.producer_id,
                rtp_capabilities,
            )
            .await?;

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
        let consumer_id = required_str(message, "consumerId")?;

        let consumer = peer
            .consumers
            .get(consumer_id)
            .map(|c| c.clone())
            .ok_or_else(|| MediaSoupError::ConsumerNotFound(consumer_id.to_string()))?;

        consumer
            .resume()
            .await
            .map_err(|e| MediaSoupError::Consumer(e.to_string()))?;

        Ok(serde_json::json!({}))
    }

    /// Handle pauseProducer request
    async fn handle_pause_producer(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
    ) -> Result<Value> {
        let producer_id = required_str(message, "producerId")?;

        let producer = peer
            .producers
            .get(producer_id)
            .map(|p| p.clone())
            .ok_or_else(|| MediaSoupError::ProducerNotFound(producer_id.to_string()))?;

        producer
            .pause()
            .await
            .map_err(|e| MediaSoupError::Producer(e.to_string()))?;

        Ok(serde_json::json!({}))
    }

    /// Handle resumeProducer request
    async fn handle_resume_producer(
        &self,
        message: &IncomingMessage,
        peer: &Arc<Peer>,
    ) -> Result<Value> {
        let producer_id = required_str(message, "producerId")?;

        let producer = peer
            .producers
            .get(producer_id)
            .map(|p| p.clone())
            .ok_or_else(|| MediaSoupError::ProducerNotFound(producer_id.to_string()))?;

        producer
            .resume()
            .await
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
        let new_room = Arc::new(Room::new(room_id.to_string(), worker).await?);

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
        if self
            .rooms
            .remove_if(room_id, |_, room| room.is_empty())
            .is_some()
        {
            info!("Removed empty room {} (router released)", room_id);
        }
    }
}

/// Worker manager to handle MediaSoup workers
pub struct CustomWorkerManager {
    workers: Vec<Worker>,
    current_worker: std::sync::atomic::AtomicUsize,
    // Retained (not read after construction) to keep the mediasoup WorkerManager —
    // and therefore the worker subprocesses it spawned — alive for the lifetime of
    // this struct. Dropping the manager would tear the workers down.
    #[allow(dead_code)]
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
        let index = self
            .current_worker
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            % self.workers.len();
        self.workers
            .get(index)
            .ok_or_else(|| MediaSoupError::Config("No workers available".to_string()))
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
    use super::{constant_time_eq, load_tls_acceptor};
    use crate::config::TlsConfig;
    use crate::error::MediaSoupError;
    use std::path::PathBuf;

    /// A scratch directory under the system temp dir, removed on drop.
    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("mediasoup-tls-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("failed to create scratch dir");
            Self(dir)
        }

        fn write(&self, name: &str, contents: &str) -> String {
            let path = self.0.join(name);
            std::fs::write(&path, contents).expect("failed to write scratch file");
            path.to_string_lossy().into_owned()
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Generate a throwaway self-signed certificate and its private key as PEM.
    fn self_signed_pem() -> (String, String) {
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
                .expect("failed to generate self-signed cert");
        (cert.pem(), signing_key.serialize_pem())
    }

    fn config_error(result: crate::error::Result<tokio_rustls::TlsAcceptor>) -> String {
        match result {
            Err(MediaSoupError::Config(msg)) => msg,
            Err(other) => panic!("expected a Config error, got {other:?}"),
            Ok(_) => panic!("expected a Config error, got a TlsAcceptor"),
        }
    }

    #[test]
    fn load_tls_acceptor_accepts_generated_pem_pair() {
        let dir = ScratchDir::new();
        let (cert_pem, key_pem) = self_signed_pem();
        let tls = TlsConfig {
            cert_path: dir.write("cert.pem", &cert_pem),
            key_path: dir.write("key.pem", &key_pem),
        };
        load_tls_acceptor(&tls).expect("generated PEM pair should load");
    }

    #[test]
    fn load_tls_acceptor_reports_missing_private_key() {
        let dir = ScratchDir::new();
        let (cert_pem, _) = self_signed_pem();
        let tls = TlsConfig {
            cert_path: dir.write("cert.pem", &cert_pem),
            // A PEM file holding only a certificate has no private key section.
            key_path: dir.write("key.pem", &cert_pem),
        };
        let msg = config_error(load_tls_acceptor(&tls));
        assert!(msg.starts_with("No private key found in "), "{msg}");
    }

    #[test]
    fn load_tls_acceptor_reports_missing_certificates() {
        let dir = ScratchDir::new();
        let (_, key_pem) = self_signed_pem();
        let tls = TlsConfig {
            cert_path: dir.write("cert.pem", "not a certificate\n"),
            key_path: dir.write("key.pem", &key_pem),
        };
        let msg = config_error(load_tls_acceptor(&tls));
        assert!(msg.starts_with("No certificates found in "), "{msg}");
    }

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
