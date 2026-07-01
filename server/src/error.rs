use std::io;
use thiserror::Error;

/// Application-specific errors
#[derive(Error, Debug)]
pub enum MediaSoupError {
    #[error("MediaSoup I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("MediaSoup create router error: {0}")]
    CreateRouter(#[from] mediasoup::worker::CreateRouterError),

    #[error("MediaSoup request error: {0}")]
    Request(#[from] mediasoup::worker::RequestError),

    #[error("MediaSoup transport error: {0}")]
    Transport(String),

    #[error("MediaSoup producer error: {0}")]
    Producer(String),

    #[error("MediaSoup consumer error: {0}")]
    Consumer(String),

    #[error("WebSocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Room not found: {0}")]
    RoomNotFound(String),

    #[error("Peer not found: {0}")]
    PeerNotFound(String),

    #[error("Transport not found: {0}")]
    TransportNotFound(String),

    #[error("Producer not found: {0}")]
    ProducerNotFound(String),

    #[error("Consumer not found: {0}")]
    ConsumerNotFound(String),

    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    #[error("Configuration error: {0}")]
    Config(String),
}

pub type Result<T> = std::result::Result<T, MediaSoupError>;
