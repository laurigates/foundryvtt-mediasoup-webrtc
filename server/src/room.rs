use crate::config::ListenIp;
use crate::error::{MediaSoupError, Result};
use crate::signaling::{NewProducerNotification, ProducerClosedNotification, SignalingMessage};
use dashmap::DashMap;
use mediasoup::prelude::*;
use serde_json::Value;
use std::sync::Arc;
use std::num::{NonZeroU32, NonZeroU8};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};
use uuid::Uuid;

/// Represents a peer connection in a room
#[derive(Debug)]
pub struct Peer {
    pub id: String,
    pub user_id: String,
    pub transports: DashMap<String, WebRtcTransport>,
    pub producers: DashMap<String, Producer>,
    pub consumers: DashMap<String, Consumer>,
    pub message_sender: mpsc::UnboundedSender<SignalingMessage>,
}

impl Peer {
    pub fn new(user_id: String, message_sender: mpsc::UnboundedSender<SignalingMessage>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            user_id,
            transports: DashMap::new(),
            producers: DashMap::new(),
            consumers: DashMap::new(),
            message_sender,
        }
    }
    
    /// Send a message to this peer
    pub fn send_message(&self, message: SignalingMessage) -> Result<()> {
        self.message_sender
            .send(message)
            .map_err(|_| MediaSoupError::InvalidRequest("Peer disconnected".to_string()))?;
        Ok(())
    }
    
    /// Close all transports, producers, and consumers
    pub async fn close(&self) -> Result<()> {
        // Note: In the new API, close methods may be private or work differently
        // For now, we'll just remove references and let Drop handlers clean up
        
        // Clear all collections
        self.consumers.clear();
        self.producers.clear();
        self.transports.clear();
        
        Ok(())
    }
}

/// Room that manages peers and MediaSoup router
#[derive(Debug)]
pub struct Room {
    pub id: String,
    pub router: Router,
    pub peers: Arc<DashMap<String, Arc<Peer>>>,
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
        })
    }
    
    /// Add a peer to the room
    pub async fn add_peer(&self, peer: Arc<Peer>) -> Result<()> {
        let peer_id = peer.id.clone();
        self.peers.insert(peer_id.clone(), peer.clone());
        
        info!("Added peer {} to room {}", peer_id, self.id);
        
        // Notify existing peers about new producer when this peer creates one
        // This will be handled in the produce method
        
        Ok(())
    }
    
    /// Remove a peer from the room
    pub async fn remove_peer(&self, peer_id: &str) -> Result<()> {
        if let Some((_, peer)) = self.peers.remove(peer_id) {
            // Close peer's resources
            peer.close().await?;
            
            // Notify other peers about closed producers
            for producer in peer.producers.iter() {
                let notification = SignalingMessage::notification(
                    "producerClosed".to_string(),
                    Some(serde_json::to_value(ProducerClosedNotification {
                        producer_id: producer.id().to_string(),
                    })?),
                );
                
                self.broadcast_to_others(&peer.id, notification).await?;
            }
            
            info!("Removed peer {} from room {}", peer_id, self.id);
        }
        
        Ok(())
    }
    
    /// Get a peer by ID
    pub fn get_peer(&self, peer_id: &str) -> Option<Arc<Peer>> {
        self.peers.get(peer_id).map(|entry| entry.clone())
    }
    
    /// Broadcast a message to all peers except the sender
    pub async fn broadcast_to_others(&self, sender_id: &str, message: SignalingMessage) -> Result<()> {
        for peer in self.peers.iter() {
            if peer.id != sender_id {
                if let Err(e) = peer.send_message(message.clone()) {
                    warn!("Failed to send message to peer {}: {}", peer.id, e);
                }
            }
        }
        Ok(())
    }
    
    /// Broadcast a message to all peers
    pub async fn broadcast_to_all(&self, message: SignalingMessage) -> Result<()> {
        for peer in self.peers.iter() {
            if let Err(e) = peer.send_message(message.clone()) {
                warn!("Failed to send message to peer {}: {}", peer.id, e);
            }
        }
        Ok(())
    }
    
    /// Create a WebRTC transport for a peer
    pub async fn create_webrtc_transport(
        &self,
        peer_id: &str,
        listen_ips: Vec<ListenIp>,
        _enable_udp: bool,
        _enable_tcp: bool,
        _prefer_udp: bool,
        _enable_sctp: bool,
    ) -> Result<WebRtcTransport> {
        let peer = self.get_peer(peer_id)
            .ok_or_else(|| MediaSoupError::PeerNotFound(peer_id.to_string()))?;
        
        // Convert custom ListenIp structs to mediasoup ListenInfo structs
        let listen_infos: Vec<ListenInfo> = listen_ips
            .into_iter()
            .map(|listen_ip| ListenInfo {
                protocol: Protocol::Udp, // Default to UDP
                ip: listen_ip.ip.parse().unwrap_or_else(|_| "0.0.0.0".parse().unwrap()),
                announced_address: listen_ip.announced_ip,
                port: None, // Let mediasoup choose
                port_range: None,
                expose_internal_ip: false, // Don't expose internal IP
                flags: None,
                send_buffer_size: None,
                recv_buffer_size: None,
            })
            .collect();

        let transport = self
            .router
            .create_webrtc_transport(WebRtcTransportOptions::new(WebRtcTransportListenInfos::new(
                listen_infos.into_iter().next().unwrap_or(ListenInfo {
                    protocol: Protocol::Udp,
                    ip: "0.0.0.0".parse().unwrap(),
                    announced_address: None,
                    port: None,
                    port_range: None,
                    expose_internal_ip: false,
                    flags: None,
                    send_buffer_size: None,
                    recv_buffer_size: None,
                }),
            )))
            .await?;
        
        let transport_id = transport.id().to_string();
        peer.transports.insert(transport_id.clone(), transport.clone());
        
        debug!("Created WebRTC transport {} for peer {}", transport_id, peer_id);
        
        Ok(transport)
    }
    
    /// Handle producer creation and notify other peers
    pub async fn create_producer(
        &self,
        peer_id: &str,
        transport_id: &str,
        kind: MediaKind,
        rtp_parameters: RtpParameters,
        app_data: Option<Value>,
    ) -> Result<Producer> {
        let peer = self.get_peer(peer_id)
            .ok_or_else(|| MediaSoupError::PeerNotFound(peer_id.to_string()))?;
        
        let transport = peer.transports.get(transport_id)
            .ok_or_else(|| MediaSoupError::TransportNotFound(transport_id.to_string()))?;
        
        let mut options = ProducerOptions::new(kind, rtp_parameters);
        if let Some(app_data) = app_data {
            options.app_data = AppData::new(app_data);
        }
        
        let producer = transport.produce(options).await
            .map_err(|e| MediaSoupError::Producer(e.to_string()))?;
        
        let producer_id = producer.id().to_string();
        peer.producers.insert(producer_id.clone(), producer.clone());
        
        info!("Created producer {} for peer {} in room {}", producer_id, peer_id, self.id);
        
        // Notify other peers about the new producer
        let notification = SignalingMessage::notification(
            "newProducer".to_string(),
            Some(serde_json::to_value(NewProducerNotification {
                id: producer_id,
                user_id: peer.user_id.clone(),
                kind: format!("{:?}", kind),
            })?),
        );
        
        self.broadcast_to_others(&peer.id, notification).await?;
        
        Ok(producer)
    }
    
    /// Create a consumer for a peer to consume another peer's producer
    pub async fn create_consumer(
        &self,
        peer_id: &str,
        transport_id: &str,
        producer_id: &str,
        rtp_capabilities: RtpCapabilities,
    ) -> Result<Consumer> {
        let peer = self.get_peer(peer_id)
            .ok_or_else(|| MediaSoupError::PeerNotFound(peer_id.to_string()))?;
        
        let transport = peer.transports.get(transport_id)
            .ok_or_else(|| MediaSoupError::TransportNotFound(transport_id.to_string()))?;
        
        // Find the producer in any peer
        let mut producer_option = None;
        for other_peer in self.peers.iter() {
            if let Some(producer) = other_peer.producers.get(producer_id) {
                producer_option = Some(producer.clone());
                break;
            }
        }
        
        let producer = producer_option
            .ok_or_else(|| MediaSoupError::ProducerNotFound(producer_id.to_string()))?;
        
        // Check if router can consume this producer
        if !self.router.can_consume(&producer.id(), &rtp_capabilities) {
            return Err(MediaSoupError::Consumer("Cannot consume producer".to_string()));
        }
        
        let consumer = transport
            .consume(ConsumerOptions::new(producer.id(), rtp_capabilities))
            .await
            .map_err(|e| MediaSoupError::Consumer(e.to_string()))?;
        
        let consumer_id = consumer.id().to_string();
        peer.consumers.insert(consumer_id.clone(), consumer.clone());
        
        debug!("Created consumer {} for peer {} in room {}", consumer_id, peer_id, self.id);
        
        Ok(consumer)
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
                parameters: RtpCodecParametersParameters::from([
                    ("profile-id".to_string(), "2".into()),
                ]),
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