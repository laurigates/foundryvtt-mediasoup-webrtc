use crate::config::ListenIp;
use crate::error::{MediaSoupError, Result};
use crate::signaling::{OutgoingMessage, ProducerInfo};
use dashmap::DashMap;
use mediasoup::prelude::*;
use serde_json::Value;
use std::num::{NonZeroU8, NonZeroU32};
use std::ops::RangeInclusive;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::{Notify, mpsc};
use tracing::{debug, info, warn};
use uuid::Uuid;

/// WebSocket close code sent to a peer that is replaced by a newer connection
/// for the same user in the same room (application range 4000-4999). Clients
/// should treat it as "do not auto-reconnect", or two tabs of one user would
/// keep evicting each other.
///
/// The user id is client-supplied and not authenticated beyond the shared
/// token, so anyone holding the token can replace any user's connection (a
/// denial of service against, say, the GM) until per-user tokens exist.
pub const CLOSE_CODE_REPLACED: u16 = 4001;

/// Lowercase wire representation of a media kind ("audio" / "video"),
/// matching the constants the FoundryVTT client compares against.
pub fn media_kind_str(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
    }
}

/// A request for a peer's connection task to shut down, with the WebSocket
/// close frame to send (if any).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseRequest {
    pub code: u16,
    pub reason: String,
}

/// How a WebRTC transport should listen. Built from the server's
/// [`WebRtcConfig`](crate::config::WebRtcConfig) plus per-request flags.
#[derive(Debug, Clone)]
pub struct TransportListenOptions {
    pub listen_ips: Vec<ListenIp>,
    pub enable_udp: bool,
    pub enable_tcp: bool,
    pub prefer_udp: bool,
    pub enable_sctp: bool,
    /// Port range for every listen socket; `None` lets the worker pick.
    pub port_range: Option<RangeInclusive<u16>>,
}

impl TransportListenOptions {
    /// Build one `ListenInfo` per enabled protocol for every listen IP.
    /// Invalid IPs are an error (there is no silent `0.0.0.0` fallback: that
    /// would advertise an unroutable candidate).
    pub fn listen_infos(&self) -> Result<Vec<ListenInfo>> {
        let mut protocols = Vec::with_capacity(2);
        if self.enable_udp {
            protocols.push(Protocol::Udp);
        }
        if self.enable_tcp {
            protocols.push(Protocol::Tcp);
        }
        if protocols.is_empty() {
            return Err(MediaSoupError::Config(
                "Neither UDP nor TCP is enabled for WebRTC transports".to_string(),
            ));
        }

        let mut infos = Vec::with_capacity(self.listen_ips.len() * protocols.len());
        for listen_ip in &self.listen_ips {
            let ip = listen_ip.ip.parse().map_err(|_| {
                MediaSoupError::Config(format!("Invalid WebRTC listen IP '{}'", listen_ip.ip))
            })?;
            for protocol in &protocols {
                infos.push(ListenInfo {
                    protocol: *protocol,
                    ip,
                    announced_address: listen_ip.announced_ip.clone(),
                    port: None,
                    port_range: self.port_range.clone(),
                    expose_internal_ip: false,
                    flags: None,
                    send_buffer_size: None,
                    recv_buffer_size: None,
                });
            }
        }

        if infos.is_empty() {
            return Err(MediaSoupError::Config(
                "No WebRTC listen IPs configured".to_string(),
            ));
        }
        Ok(infos)
    }
}

/// Represents a peer connection in a room
#[derive(Debug)]
pub struct Peer {
    pub id: String,
    pub user_id: String,
    /// The client's per-page session id (`authenticate.sessionId`), if sent.
    pub session_id: Option<String>,
    pub transports: DashMap<String, WebRtcTransport>,
    pub producers: DashMap<String, Producer>,
    pub consumers: DashMap<String, Consumer>,
    pub message_sender: mpsc::UnboundedSender<OutgoingMessage>,
    shutdown: Notify,
    close_request: Mutex<Option<CloseRequest>>,
}

impl Peer {
    pub fn new(user_id: String, message_sender: mpsc::UnboundedSender<OutgoingMessage>) -> Self {
        Self::with_session(user_id, None, message_sender)
    }

    /// A peer whose client sent a session id in `authenticate`.
    pub fn with_session(
        user_id: String,
        session_id: Option<String>,
        message_sender: mpsc::UnboundedSender<OutgoingMessage>,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            user_id,
            session_id,
            transports: DashMap::new(),
            producers: DashMap::new(),
            consumers: DashMap::new(),
            message_sender,
            shutdown: Notify::new(),
            close_request: Mutex::new(None),
        }
    }

    /// Send a message to this peer
    pub fn send_message(&self, message: OutgoingMessage) -> Result<()> {
        self.message_sender
            .send(message)
            .map_err(|_| MediaSoupError::InvalidRequest("Peer disconnected".to_string()))?;
        Ok(())
    }

    /// Ask this peer's connection task to stop (e.g. it was replaced by a newer
    /// connection, or it stopped answering pings). `close` is the close frame
    /// to send, if any. Only the first request's close frame is kept.
    pub fn request_shutdown(&self, close: Option<CloseRequest>) {
        if let Ok(mut slot) = self.close_request.lock()
            && slot.is_none()
        {
            *slot = close;
        }
        // `notify_one` stores a permit, so a request made before the connection
        // task starts waiting is not lost.
        self.shutdown.notify_one();
    }

    /// Resolves once [`Peer::request_shutdown`] has been called.
    pub async fn shutdown_requested(&self) {
        self.shutdown.notified().await;
    }

    /// Take the close frame stored by [`Peer::request_shutdown`].
    pub fn take_close_request(&self) -> Option<CloseRequest> {
        self.close_request
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
    }

    /// Close all transports, producers, and consumers.
    ///
    /// mediasoup-rust closes each object when its last handle is dropped, so
    /// clearing the maps (which hold the only long-lived handles) closes them.
    pub fn close(&self) {
        self.consumers.clear();
        self.producers.clear();
        self.transports.clear();
    }
}

/// Room that manages peers and MediaSoup router
#[derive(Debug)]
pub struct Room {
    pub id: String,
    pub router: Router,
    pub peers: Arc<DashMap<String, Arc<Peer>>>,
    /// Serializes joins so "evict same-user peers, then insert" is atomic with
    /// respect to other joins.
    join_lock: Mutex<()>,
}

impl Room {
    /// Create a new room with a MediaSoup router
    pub async fn new(id: String, worker: &Worker) -> Result<Self> {
        let router = worker
            .create_router(RouterOptions::new(Self::media_codecs()))
            .await?;

        info!("Created room {} with router {}", id, router.id());

        Ok(Self {
            id,
            router,
            peers: Arc::new(DashMap::new()),
            join_lock: Mutex::new(()),
        })
    }

    /// Add a peer that starts a new session (see [`Room::join_peer`]).
    pub fn add_peer(&self, peer: Arc<Peer>) -> Vec<Arc<Peer>> {
        // A new session is never refused.
        self.join_peer(peer, false).unwrap_or_default()
    }

    /// Add a peer to the room.
    ///
    /// Any older peer with the same `user_id` (a reload, a second tab, or a
    /// half-dead socket) is evicted first: its producers are announced as
    /// closed to the rest of the room, its resources are released, and its
    /// connection is asked to close with [`CLOSE_CODE_REPLACED`]. Returns the
    /// evicted peers.
    ///
    /// A `reconnect` join (a client's backoff loop after a connection loss)
    /// may only replace connections of its own session: if the same user has
    /// a peer from a different (or unknown) session, that is a newer tab that
    /// took over, and the join is refused instead of evicting it.
    pub fn join_peer(&self, peer: Arc<Peer>, reconnect: bool) -> Result<Vec<Arc<Peer>>> {
        let evicted: Vec<Arc<Peer>> = {
            let _guard = self.join_lock.lock().unwrap_or_else(|e| e.into_inner());
            let duplicates: Vec<(String, bool)> = self
                .peers
                .iter()
                .filter(|p| p.user_id == peer.user_id && p.id != peer.id)
                .map(|p| {
                    let same_session = peer.session_id.is_some() && p.session_id == peer.session_id;
                    (p.id.clone(), same_session)
                })
                .collect();
            if reconnect && duplicates.iter().any(|(_, same_session)| !same_session) {
                return Err(MediaSoupError::InvalidRequest(format!(
                    "User {} is already connected from another session",
                    peer.user_id
                )));
            }
            let duplicate_ids: Vec<String> = duplicates.into_iter().map(|(id, _)| id).collect();
            let evicted = duplicate_ids
                .iter()
                .filter_map(|id| self.peers.remove(id).map(|(_, p)| p))
                .collect();
            self.peers.insert(peer.id.clone(), peer.clone());
            evicted
        };

        for old in &evicted {
            info!(
                "Evicting peer {} (user {}) from room {}: replaced by peer {}",
                old.id, old.user_id, self.id, peer.id
            );
            self.release_peer(old);
            old.request_shutdown(Some(CloseRequest {
                code: CLOSE_CODE_REPLACED,
                reason: "Replaced by a newer connection for the same user".to_string(),
            }));
        }

        info!(
            "Added peer {} (user {}) to room {}",
            peer.id, peer.user_id, self.id
        );
        Ok(evicted)
    }

    /// Remove a peer from the room. Returns whether it was present.
    pub fn remove_peer(&self, peer_id: &str) -> bool {
        match self.peers.remove(peer_id) {
            Some((_, peer)) => {
                self.release_peer(&peer);
                info!("Removed peer {} from room {}", peer_id, self.id);
                true
            }
            None => false,
        }
    }

    /// Announce a detached peer's producers as closed, then release its
    /// mediasoup resources. The ids are collected before `Peer::close` clears
    /// the producer map; otherwise no `producerClosed` would fire and the
    /// remaining peers' consumers would hang.
    fn release_peer(&self, peer: &Peer) {
        let producer_ids: Vec<String> = peer
            .producers
            .iter()
            .map(|producer| producer.id().to_string())
            .collect();
        for producer_id in producer_ids {
            self.notify_producer_closed(&peer.id, &producer_id);
        }
        peer.close();
    }

    /// Tell every peer except the producer's owner that `producer_id` is gone.
    /// Shared by `closeProducer` and peer removal/eviction.
    pub fn notify_producer_closed(&self, owner_peer_id: &str, producer_id: &str) {
        let notification = OutgoingMessage::notification(
            "producerClosed",
            serde_json::json!({ "producerId": producer_id }),
        );
        self.broadcast_to_others(owner_peer_id, notification);
    }

    /// Get a peer by ID
    pub fn get_peer(&self, peer_id: &str) -> Option<Arc<Peer>> {
        self.peers.get(peer_id).map(|entry| entry.clone())
    }

    fn require_peer(&self, peer_id: &str) -> Result<Arc<Peer>> {
        self.get_peer(peer_id)
            .ok_or_else(|| MediaSoupError::PeerNotFound(peer_id.to_string()))
    }

    /// Whether the room has no peers (used to release empty rooms/routers).
    pub fn is_empty(&self) -> bool {
        self.peers.is_empty()
    }

    /// Broadcast a message to all peers except the sender
    pub fn broadcast_to_others(&self, sender_id: &str, message: OutgoingMessage) {
        for peer in self.peers.iter() {
            if peer.id != sender_id
                && let Err(e) = peer.send_message(message.clone())
            {
                warn!("Failed to send message to peer {}: {}", peer.id, e);
            }
        }
    }

    /// Broadcast a message to all peers
    pub fn broadcast_to_all(&self, message: OutgoingMessage) {
        for peer in self.peers.iter() {
            if let Err(e) = peer.send_message(message.clone()) {
                warn!("Failed to send message to peer {}: {}", peer.id, e);
            }
        }
    }

    /// Every producer in the room except those owned by `peer_id` (the
    /// `getProducers` snapshot a late joiner consumes).
    pub fn list_producers_except(&self, peer_id: &str) -> Vec<ProducerInfo> {
        let mut producers = Vec::new();
        for peer in self.peers.iter().filter(|p| p.id != peer_id) {
            for producer in peer.producers.iter() {
                producers.push(ProducerInfo {
                    producer_id: producer.id().to_string(),
                    user_id: peer.user_id.clone(),
                    kind: media_kind_str(producer.kind()).to_string(),
                    paused: producer.paused(),
                });
            }
        }
        producers
    }

    /// Create a WebRTC transport for a peer
    pub async fn create_webrtc_transport(
        &self,
        peer_id: &str,
        listen: &TransportListenOptions,
    ) -> Result<WebRtcTransport> {
        let peer = self.require_peer(peer_id)?;

        let mut infos = listen.listen_infos()?.into_iter();
        // `listen_infos` guarantees at least one entry.
        let first = infos
            .next()
            .ok_or_else(|| MediaSoupError::Config("No WebRTC listen IPs configured".into()))?;
        let listen_infos = infos.fold(WebRtcTransportListenInfos::new(first), |acc, info| {
            acc.insert(info)
        });

        let mut options = WebRtcTransportOptions::new(listen_infos);
        options.enable_udp = listen.enable_udp;
        options.enable_tcp = listen.enable_tcp;
        options.prefer_udp = listen.prefer_udp && listen.enable_udp && listen.enable_tcp;
        options.enable_sctp = listen.enable_sctp;

        let transport = self.router.create_webrtc_transport(options).await?;

        let transport_id = transport.id().to_string();
        peer.transports
            .insert(transport_id.clone(), transport.clone());

        debug!(
            "Created WebRTC transport {} for peer {}",
            transport_id, peer_id
        );

        Ok(transport)
    }

    /// Restart ICE on one of the peer's transports, returning the new local
    /// ICE parameters for the client's `transport.restartIce()`.
    pub async fn restart_ice(&self, peer_id: &str, transport_id: &str) -> Result<IceParameters> {
        let peer = self.require_peer(peer_id)?;
        // Clone the handle so no DashMap guard is held across `.await`.
        let transport = peer
            .transports
            .get(transport_id)
            .map(|t| t.clone())
            .ok_or_else(|| MediaSoupError::TransportNotFound(transport_id.to_string()))?;

        let ice_parameters = transport
            .restart_ice()
            .await
            .map_err(|e| MediaSoupError::Transport(e.to_string()))?;
        debug!(
            "Restarted ICE on transport {} for peer {}",
            transport_id, peer_id
        );
        Ok(ice_parameters)
    }

    /// Handle producer creation and notify other peers
    pub async fn create_producer(
        &self,
        peer_id: &str,
        transport_id: &str,
        kind: MediaKind,
        rtp_parameters: RtpParameters,
        app_data: Option<Value>,
        paused: bool,
    ) -> Result<Producer> {
        let peer = self.require_peer(peer_id)?;

        let transport = peer
            .transports
            .get(transport_id)
            .map(|t| t.clone())
            .ok_or_else(|| MediaSoupError::TransportNotFound(transport_id.to_string()))?;

        let mut options = ProducerOptions::new(kind, rtp_parameters);
        options.paused = paused;
        if let Some(app_data) = app_data {
            options.app_data = AppData::new(app_data);
        }

        let producer = transport
            .produce(options)
            .await
            .map_err(|e| MediaSoupError::Producer(e.to_string()))?;

        let producer_id = producer.id().to_string();
        peer.producers.insert(producer_id.clone(), producer.clone());

        // The peer may have been evicted or removed while `produce` was in
        // flight; do not announce a producer nobody can consume.
        if !self.peers.contains_key(&peer.id) {
            peer.producers.remove(&producer_id);
            return Err(MediaSoupError::PeerNotFound(peer.id.clone()));
        }

        info!(
            "Created producer {} for peer {} in room {}",
            producer_id, peer_id, self.id
        );

        // Notify other peers about the new producer. Fields are flat and the
        // kind is lowercased ("audio"/"video") to match the client.
        let notification = OutgoingMessage::notification(
            "newProducer",
            serde_json::json!({
                "producerId": producer_id,
                "userId": peer.user_id.clone(),
                "kind": media_kind_str(kind),
                "paused": producer.paused(),
            }),
        );

        self.broadcast_to_others(&peer.id, notification);

        Ok(producer)
    }

    /// Close one of the peer's own producers and announce `producerClosed` to
    /// the other peers. A peer can only close producers it owns.
    pub fn close_producer(&self, peer_id: &str, producer_id: &str) -> Result<()> {
        let peer = self.require_peer(peer_id)?;
        let (_, producer) = peer
            .producers
            .remove(producer_id)
            .ok_or_else(|| MediaSoupError::ProducerNotFound(producer_id.to_string()))?;

        self.notify_producer_closed(&peer.id, producer_id);
        // Dropping the last handle closes the producer in the worker, which in
        // turn closes every consumer of it (see `create_consumer`).
        drop(producer);

        info!(
            "Closed producer {} for peer {} in room {}",
            producer_id, peer_id, self.id
        );
        Ok(())
    }

    /// Create a consumer for a peer to consume another peer's producer
    pub async fn create_consumer(
        &self,
        peer_id: &str,
        transport_id: &str,
        producer_id: &str,
        rtp_capabilities: RtpCapabilities,
    ) -> Result<Consumer> {
        let peer = self.require_peer(peer_id)?;

        let transport = peer
            .transports
            .get(transport_id)
            .map(|t| t.clone())
            .ok_or_else(|| MediaSoupError::TransportNotFound(transport_id.to_string()))?;

        // Find the producer in any peer
        let producer = self
            .peers
            .iter()
            .find_map(|other_peer| other_peer.producers.get(producer_id).map(|p| p.clone()))
            .ok_or_else(|| MediaSoupError::ProducerNotFound(producer_id.to_string()))?;

        // Check if router can consume this producer
        if !self.router.can_consume(&producer.id(), &rtp_capabilities) {
            return Err(MediaSoupError::Consumer(
                "Cannot consume producer".to_string(),
            ));
        }

        // Create the consumer paused, as recommended by mediasoup, so the client
        // can be ready before media flows. The client resumes it via the
        // `consumerResume` request once the local consumer is set up.
        let mut consumer_options = ConsumerOptions::new(producer.id(), rtp_capabilities);
        consumer_options.paused = true;

        let consumer = transport
            .consume(consumer_options)
            .await
            .map_err(|e| MediaSoupError::Consumer(e.to_string()))?;
        // Do not keep the producer handle alive past this point: only the
        // owner's map may hold it, so `closeProducer` really closes it.
        drop(producer);

        let consumer_id = consumer.id().to_string();

        // Register before hooking the close handler below, so a close that
        // races this call always finds (and removes) the entry.
        peer.consumers.insert(consumer_id.clone(), consumer.clone());

        // Forward the producer's pause state to the consuming peer, so its
        // view of the remote track (paused / live) does not go stale on each
        // push-to-talk press, mute or camera hide. Sending only queues on the
        // peer's channel, so it is safe on mediasoup's notification thread.
        // The peer is held weakly: it owns the consumer, which owns these
        // handlers.
        for (paused, msg_type) in [(true, "producerPaused"), (false, "producerResumed")] {
            let weak_peer: Weak<Peer> = Arc::downgrade(&peer);
            let producer_id = producer_id.to_string();
            let notify = move || {
                if let Some(peer) = weak_peer.upgrade() {
                    let notification = OutgoingMessage::notification(
                        msg_type,
                        serde_json::json!({ "producerId": producer_id }),
                    );
                    if let Err(e) = peer.send_message(notification) {
                        debug!("Could not tell peer {} about {}: {}", peer.id, msg_type, e);
                    }
                }
            };
            let handler = if paused {
                consumer.on_producer_pause(notify)
            } else {
                consumer.on_producer_resume(notify)
            };
            handler.detach();
        }

        // When the producer goes away (closeProducer, owner disconnect or
        // eviction) mediasoup closes this consumer; drop our handle too so
        // `peer.consumers` does not accumulate dead entries. `on_close` (not
        // `on_producer_close`) also runs, in place, when the consumer closed
        // before this line, so a close racing the insert above is not missed.
        // The callback can run on mediasoup's notification thread, where
        // dropping a consumer can deadlock, so the removal is moved onto the
        // tokio runtime.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let weak_peer: Weak<Peer> = Arc::downgrade(&peer);
            let id = consumer_id.clone();
            consumer
                .on_close(move || {
                    runtime.spawn(async move {
                        if let Some(peer) = weak_peer.upgrade()
                            && peer.consumers.remove(&id).is_some()
                        {
                            debug!("Consumer {} closed", id);
                        }
                    });
                })
                .detach();
        }

        // Do not hand the client a consumer whose producer already closed.
        if consumer.closed() {
            peer.consumers.remove(&consumer_id);
            return Err(MediaSoupError::Consumer(format!(
                "Producer {producer_id} closed while it was being consumed"
            )));
        }

        debug!(
            "Created consumer {} for peer {} in room {}",
            consumer_id, peer_id, self.id
        );

        Ok(consumer)
    }

    /// Close one of the peer's own consumers.
    pub fn close_consumer(&self, peer_id: &str, consumer_id: &str) -> Result<()> {
        let peer = self.require_peer(peer_id)?;
        peer.consumers
            .remove(consumer_id)
            .map(|_| ())
            .ok_or_else(|| MediaSoupError::ConsumerNotFound(consumer_id.to_string()))?;
        debug!("Closed consumer {} for peer {}", consumer_id, peer_id);
        Ok(())
    }

    /// Get RTP capabilities of the router
    pub fn get_rtp_capabilities(&self) -> RtpCapabilitiesFinalized {
        self.router.rtp_capabilities()
    }

    /// Define media codecs for the router
    fn media_codecs() -> Vec<RtpCodecCapability> {
        vec![
            // Audio codecs
            RtpCodecCapability::Audio {
                mime_type: MimeTypeAudio::Opus,
                preferred_payload_type: None,
                clock_rate: NonZeroU32::new(48000).unwrap(),
                channels: NonZeroU8::new(2).unwrap(),
                parameters: RtpCodecParametersParameters::default(),
                rtcp_feedback: vec![],
            },
            // Video codecs
            RtpCodecCapability::Video {
                mime_type: MimeTypeVideo::Vp8,
                preferred_payload_type: None,
                clock_rate: NonZeroU32::new(90000).unwrap(),
                parameters: RtpCodecParametersParameters::default(),
                rtcp_feedback: vec![
                    RtcpFeedback::Nack,
                    RtcpFeedback::NackPli,
                    RtcpFeedback::CcmFir,
                    RtcpFeedback::GoogRemb,
                ],
            },
            RtpCodecCapability::Video {
                mime_type: MimeTypeVideo::Vp9,
                preferred_payload_type: None,
                clock_rate: NonZeroU32::new(90000).unwrap(),
                parameters: RtpCodecParametersParameters::from([(
                    "profile-id".to_string(),
                    "2".into(),
                )]),
                rtcp_feedback: vec![
                    RtcpFeedback::Nack,
                    RtcpFeedback::NackPli,
                    RtcpFeedback::CcmFir,
                    RtcpFeedback::GoogRemb,
                ],
            },
            RtpCodecCapability::Video {
                mime_type: MimeTypeVideo::H264,
                preferred_payload_type: None,
                clock_rate: NonZeroU32::new(90000).unwrap(),
                parameters: RtpCodecParametersParameters::from([
                    ("packetization-mode".to_string(), "1".into()),
                    ("profile-level-id".to_string(), "4d0032".into()),
                    ("level-asymmetry-allowed".to_string(), "1".into()),
                ]),
                rtcp_feedback: vec![
                    RtcpFeedback::Nack,
                    RtcpFeedback::NackPli,
                    RtcpFeedback::CcmFir,
                    RtcpFeedback::GoogRemb,
                ],
            },
        ]
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use mediasoup::worker::WorkerSettings;
    use mediasoup::worker_manager::WorkerManager;

    async fn test_room() -> (WorkerManager, Worker, Room) {
        let worker_manager = WorkerManager::new();
        let worker = worker_manager
            .create_worker(WorkerSettings::default())
            .await
            .expect("failed to spawn mediasoup worker");
        let room = Room::new("test".to_string(), &worker)
            .await
            .expect("failed to create room");
        (worker_manager, worker, room)
    }

    fn new_peer(user_id: &str) -> (Arc<Peer>, mpsc::UnboundedReceiver<OutgoingMessage>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(Peer::new(user_id.to_string(), tx)), rx)
    }

    fn loopback_listen() -> TransportListenOptions {
        TransportListenOptions {
            listen_ips: vec![ListenIp {
                ip: "127.0.0.1".to_string(),
                announced_ip: None,
            }],
            enable_udp: true,
            enable_tcp: true,
            prefer_udp: true,
            enable_sctp: false,
            port_range: None,
        }
    }

    /// RTP parameters shaped like a Chrome Opus send track.
    fn opus_rtp_parameters(ssrc: u32) -> RtpParameters {
        serde_json::from_value(serde_json::json!({
            "mid": "0",
            "codecs": [{
                "mimeType": "audio/opus",
                "payloadType": 111,
                "clockRate": 48000,
                "channels": 2,
                "parameters": { "minptime": 10, "useinbandfec": 1 },
                "rtcpFeedback": [{ "type": "transport-cc", "parameter": "" }]
            }],
            "headerExtensions": [
                { "uri": "urn:ietf:params:rtp-hdrext:sdes:mid", "id": 4, "encrypt": false, "parameters": {} },
                { "uri": "urn:ietf:params:rtp-hdrext:ssrc-audio-level", "id": 1, "encrypt": false, "parameters": {} }
            ],
            "encodings": [{ "ssrc": ssrc, "dtx": false }],
            "rtcp": { "cname": "test-cname", "reducedSize": true }
        }))
        .expect("valid Opus RTP parameters")
    }

    async fn produce_audio(room: &Room, peer: &Peer, ssrc: u32) -> Producer {
        let transport = room
            .create_webrtc_transport(&peer.id, &loopback_listen())
            .await
            .expect("failed to create transport");
        room.create_producer(
            &peer.id,
            &transport.id().to_string(),
            MediaKind::Audio,
            opus_rtp_parameters(ssrc),
            None,
            false,
        )
        .await
        .expect("failed to produce")
    }

    fn new_session_peer(
        user_id: &str,
        session_id: &str,
    ) -> (Arc<Peer>, mpsc::UnboundedReceiver<OutgoingMessage>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let peer = Peer::with_session(user_id.to_string(), Some(session_id.to_string()), tx);
        (Arc::new(peer), rx)
    }

    /// A reconnect replaces only its own session's stale connection; it never
    /// evicts a newer session (another tab) of the same user.
    #[tokio::test]
    async fn reconnect_join_respects_other_sessions() {
        let (_manager, _worker, room) = test_room().await;
        let (stale, _rx_stale) = new_session_peer("user-a", "tab-1");
        room.add_peer(stale.clone());

        // Same session re-joining after a connection loss: replaces its stale peer.
        let (again, _rx_again) = new_session_peer("user-a", "tab-1");
        let evicted = room.join_peer(again.clone(), true).expect("same session");
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].id, stale.id);

        // A new tab (fresh join) takes over.
        let (tab2, _rx_tab2) = new_session_peer("user-a", "tab-2");
        let evicted = room.join_peer(tab2.clone(), false).expect("fresh join");
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].id, again.id);

        // The first tab's backoff loop must not evict the newer tab.
        let (late, _rx_late) = new_session_peer("user-a", "tab-1");
        let err = room.join_peer(late.clone(), true).expect_err("refused");
        assert!(err.to_string().contains("another session"), "{err}");
        assert!(room.get_peer(&tab2.id).is_some());
        assert!(room.get_peer(&late.id).is_none());
        assert_eq!(room.peers.len(), 1);

        // A reconnect of a user with no other peer is accepted.
        let (solo, _rx_solo) = new_session_peer("user-b", "tab-9");
        assert!(room.join_peer(solo, true).expect("no conflict").is_empty());
    }

    /// A producer created paused is born paused and announced as such.
    #[tokio::test]
    async fn create_producer_can_start_paused() {
        let (_manager, _worker, room) = test_room().await;
        let (a, _rx_a) = new_peer("user-a");
        let (b, mut rx_b) = new_peer("user-b");
        room.add_peer(a.clone());
        room.add_peer(b.clone());
        let transport = room
            .create_webrtc_transport(&a.id, &loopback_listen())
            .await
            .expect("transport");
        let producer = room
            .create_producer(
                &a.id,
                &transport.id().to_string(),
                MediaKind::Audio,
                opus_rtp_parameters(4444),
                None,
                true,
            )
            .await
            .expect("produce");
        assert!(producer.paused());
        let announced = rx_b.try_recv().expect("newProducer");
        assert_eq!(announced.msg_type.as_deref(), Some("newProducer"));
        assert_eq!(announced.extra["paused"], true);
        assert!(room.list_producers_except(&b.id)[0].paused);
    }

    /// A room reports empty until a peer joins and again once it leaves, which is
    /// what lets the server release empty rooms/routers instead of leaking them.
    #[tokio::test]
    async fn is_empty_tracks_peer_membership() {
        let (_manager, _worker, room) = test_room().await;
        assert!(room.is_empty());

        let (peer, _rx) = new_peer("user-1");
        let peer_id = peer.id.clone();
        assert!(room.add_peer(peer).is_empty());
        assert!(!room.is_empty());

        assert!(room.remove_peer(&peer_id));
        assert!(room.is_empty());
        assert!(!room.remove_peer(&peer_id), "second removal is a no-op");
    }

    /// `list_producers_except` returns every other peer's producers (with the
    /// owner's user id, lowercase kind and paused state) and never the caller's.
    #[tokio::test]
    async fn list_producers_except_excludes_the_caller() {
        let (_manager, _worker, room) = test_room().await;
        let (a, _rx_a) = new_peer("user-a");
        let (b, _rx_b) = new_peer("user-b");
        room.add_peer(a.clone());
        room.add_peer(b.clone());

        assert!(room.list_producers_except(&b.id).is_empty());

        let producer = produce_audio(&room, &a, 1111).await;
        let producer_id = producer.id().to_string();

        let seen_by_b = room.list_producers_except(&b.id);
        assert_eq!(
            seen_by_b,
            vec![ProducerInfo {
                producer_id: producer_id.clone(),
                user_id: "user-a".to_string(),
                kind: "audio".to_string(),
                paused: false,
            }]
        );
        assert!(
            room.list_producers_except(&a.id).is_empty(),
            "a peer never sees its own producers"
        );

        producer.pause().await.expect("pause");
        assert!(room.list_producers_except(&b.id)[0].paused);

        drop(producer);
        room.close_producer(&a.id, &producer_id)
            .expect("owner can close its producer");
        assert!(room.list_producers_except(&b.id).is_empty());
    }

    /// closeProducer is owner-only, notifies the other peers, and unknown ids
    /// are an error.
    #[tokio::test]
    async fn close_producer_requires_ownership_and_notifies_others() {
        let (_manager, _worker, room) = test_room().await;
        let (a, mut rx_a) = new_peer("user-a");
        let (b, mut rx_b) = new_peer("user-b");
        room.add_peer(a.clone());
        room.add_peer(b.clone());

        let producer_id = produce_audio(&room, &a, 2222).await.id().to_string();
        // B was told about the new producer.
        let new_producer = rx_b.try_recv().expect("newProducer for B");
        assert_eq!(new_producer.msg_type.as_deref(), Some("newProducer"));

        assert!(matches!(
            room.close_producer(&b.id, &producer_id),
            Err(MediaSoupError::ProducerNotFound(_))
        ));
        room.close_producer(&a.id, &producer_id)
            .expect("owner close");
        assert!(matches!(
            room.close_producer(&a.id, &producer_id),
            Err(MediaSoupError::ProducerNotFound(_))
        ));

        let closed = rx_b.try_recv().expect("producerClosed for B");
        assert_eq!(closed.msg_type.as_deref(), Some("producerClosed"));
        assert_eq!(closed.extra["producerId"], producer_id.as_str());
        assert!(rx_a.try_recv().is_err(), "the owner is not notified");
    }

    /// A second peer with the same user id evicts the first: the first's
    /// producers are announced closed and its connection is asked to close.
    #[tokio::test]
    async fn add_peer_evicts_same_user() {
        let (_manager, _worker, room) = test_room().await;
        let (old, _rx_old) = new_peer("user-a");
        let (other, mut rx_other) = new_peer("user-b");
        room.add_peer(old.clone());
        room.add_peer(other.clone());
        let producer_id = produce_audio(&room, &old, 3333).await.id().to_string();
        let _ = rx_other.try_recv(); // newProducer

        let (new, _rx_new) = new_peer("user-a");
        let evicted = room.add_peer(new.clone());
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].id, old.id);
        assert!(room.get_peer(&old.id).is_none());
        assert!(room.get_peer(&new.id).is_some());
        assert_eq!(room.peers.len(), 2);
        assert!(
            old.producers.is_empty(),
            "evicted peer's resources released"
        );

        let closed = rx_other.try_recv().expect("producerClosed for other");
        assert_eq!(closed.msg_type.as_deref(), Some("producerClosed"));
        assert_eq!(closed.extra["producerId"], producer_id.as_str());

        tokio::time::timeout(std::time::Duration::from_secs(1), old.shutdown_requested())
            .await
            .expect("evicted peer was asked to shut down");
        assert_eq!(
            old.take_close_request().map(|c| c.code),
            Some(CLOSE_CODE_REPLACED)
        );
    }

    #[test]
    fn listen_infos_cover_every_ip_and_enabled_protocol() {
        let mut listen = loopback_listen();
        listen.listen_ips.push(ListenIp {
            ip: "::1".to_string(),
            announced_ip: Some("sfu.example.com".to_string()),
        });
        listen.port_range = Some(40000..=40100);
        let infos = listen.listen_infos().expect("valid");
        let summary: Vec<(Protocol, String, Option<String>)> = infos
            .iter()
            .map(|i| (i.protocol, i.ip.to_string(), i.announced_address.clone()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (Protocol::Udp, "127.0.0.1".to_string(), None),
                (Protocol::Tcp, "127.0.0.1".to_string(), None),
                (
                    Protocol::Udp,
                    "::1".to_string(),
                    Some("sfu.example.com".to_string())
                ),
                (
                    Protocol::Tcp,
                    "::1".to_string(),
                    Some("sfu.example.com".to_string())
                ),
            ]
        );
        assert!(infos.iter().all(|i| i.port_range == Some(40000..=40100)));

        let mut udp_only = loopback_listen();
        udp_only.enable_tcp = false;
        let infos = udp_only.listen_infos().expect("valid");
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].protocol, Protocol::Udp);

        let mut none = loopback_listen();
        none.enable_udp = false;
        none.enable_tcp = false;
        assert!(none.listen_infos().is_err());

        let mut bad_ip = loopback_listen();
        bad_ip.listen_ips[0].ip = "nope".to_string();
        assert!(bad_ip.listen_infos().is_err(), "no silent 0.0.0.0 fallback");
    }
}
