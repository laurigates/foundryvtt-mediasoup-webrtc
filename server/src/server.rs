use crate::config::Config;
use crate::error::{MediaSoupError, Result};
use crate::room::{media_kind_str, Peer, Room};
use crate::signaling::*;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use mediasoup::prelude::*;
use mediasoup::worker_manager::WorkerManager;
use mediasoup::worker::WorkerSettings;
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

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
        
        info!("WebSocket server listening on {}", self.config.listen_addr);
        
        let server = Arc::new(self);
        
        while let Ok((stream, addr)) = listener.accept().await {
            let server_clone = server.clone();
            tokio::spawn(async move {
                if let Err(e) = server_clone.handle_connection(stream, addr).await {
                    error!("Error handling connection from {}: {}", addr, e);
                }
            });
        }
        
        Ok(())
    }
    
    /// Handle a new WebSocket connection
    async fn handle_connection(&self, stream: TcpStream, addr: SocketAddr) -> Result<()> {
        info!("New connection from {}", addr);
        
        let ws_stream = accept_async(stream).await?;
        let (mut ws_sender, mut ws_receiver) = ws_stream.split();
        
        // Create a channel for sending messages to this peer
        let (message_sender, mut message_receiver) = mpsc::unbounded_channel::<OutgoingMessage>();
        
        // Extract user ID from connection (for now use a UUID, in production this would come from authentication)
        let user_id = Uuid::new_v4().to_string();
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
        
        info!("Connection from {} closed", addr);
        incoming_result
    }
    
    /// Handle incoming WebSocket messages
    async fn handle_incoming_messages(
        &self,
        ws_receiver: &mut futures_util::stream::SplitStream<WebSocketStream<TcpStream>>,
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
    
    /// Get or create a room
    async fn get_or_create_room(&self, room_id: &str) -> Result<Arc<Room>> {
        if let Some(room) = self.rooms.get(room_id) {
            Ok(room.clone())
        } else {
            let worker = self.worker_manager.get_worker().await?;
            let room = Arc::new(Room::new(room_id.to_string(), &worker).await?);
            self.rooms.insert(room_id.to_string(), room.clone());
            Ok(room)
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
        
        for i in 0..config.worker.num_workers {
            let worker_settings = WorkerSettings::default();
            // TODO: Configure worker settings for log level, tags, and RTC ports
            
            let worker = worker_manager.create_worker(worker_settings).await?;
            info!("Created MediaSoup worker {} with ID {}", i, worker.id());
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
    
    // TODO: Re-implement log level and tag parsing once we understand the new API
    /*
    /// Parse log level from string
    fn parse_log_level(level: &str) -> WorkerLogLevel {
        match level.to_lowercase().as_str() {
            "debug" => WorkerLogLevel::Debug,
            "warn" => WorkerLogLevel::Warn,
            "error" => WorkerLogLevel::Error,
            _ => WorkerLogLevel::Warn,
        }
    }
    
    /// Parse log tag from string
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
    */
}