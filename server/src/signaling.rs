use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Incoming signaling frame from the FoundryVTT client.
///
/// The client uses a flat envelope:
/// `{ "type", "requestId", "userId", <payload fields...> }`
/// (see `src/client/MediaSoupVTTClient.ts` `_sendSignalingRequest`).
#[derive(Debug, Clone, Deserialize)]
pub struct IncomingMessage {
    /// Operation name, e.g. `produce`, `consume`, `getRouterRtpCapabilities`.
    #[serde(rename = "type")]
    pub msg_type: String,

    /// Correlation id, present on requests that expect a response.
    #[serde(rename = "requestId", default)]
    pub request_id: Option<String>,

    /// Client-supplied user id (informational; authentication is out of scope).
    #[serde(rename = "userId", default)]
    pub user_id: Option<String>,

    /// All remaining top-level fields (transportId, kind, rtpParameters, ...).
    #[serde(flatten)]
    pub payload: Map<String, Value>,
}

/// Why a raw signaling frame could not be turned into an [`IncomingMessage`].
///
/// Carries the `requestId` when the frame was at least a JSON object with a
/// string `requestId`, so the server can still correlate its error reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameParseError {
    pub request_id: Option<String>,
    pub error: String,
}

impl IncomingMessage {
    /// Parse a raw text frame in two steps: first to a generic JSON value, then
    /// to the typed envelope. Parsing to a `Value` first means a frame that is
    /// valid JSON but has the wrong shape (e.g. a numeric `type`) still yields
    /// its `requestId`, so the client gets an error reply instead of silence
    /// and its pending request does not hang until timeout.
    pub fn parse(text: &str) -> std::result::Result<Self, FrameParseError> {
        let value: Value = serde_json::from_str(text).map_err(|e| FrameParseError {
            request_id: None,
            error: format!("Malformed signaling frame: invalid JSON: {e}"),
        })?;

        let request_id = value
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_string);

        if !value.is_object() {
            return Err(FrameParseError {
                request_id,
                error: "Malformed signaling frame: expected a JSON object".to_string(),
            });
        }

        serde_json::from_value(value).map_err(|e| FrameParseError {
            request_id,
            error: format!("Malformed signaling frame: {e}"),
        })
    }

    /// Return the payload fields as a JSON object value for typed deserialization.
    pub fn payload_value(&self) -> Value {
        Value::Object(self.payload.clone())
    }
}

/// Outgoing signaling frame to the client.
///
/// Responses use `{ "requestId", "data"? , "error"? }`; notifications use
/// `{ "type", <flat fields...> }`. These shapes match what the client parses in
/// `_handleSignalingMessage` (correlates on top-level `requestId`, reads
/// top-level `error`, resolves with `message.data`, and switches notifications
/// on top-level `type`).
#[derive(Debug, Clone, Serialize)]
pub struct OutgoingMessage {
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,

    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub msg_type: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,

    /// Flattened notification fields (producerId, userId, kind, ...).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl OutgoingMessage {
    /// Successful response to a request.
    pub fn response(request_id: String, data: Value) -> Self {
        Self {
            request_id: Some(request_id),
            msg_type: None,
            error: None,
            data: Some(data),
            extra: Map::new(),
        }
    }

    /// Error response to a request.
    pub fn error(request_id: String, error: String) -> Self {
        Self {
            request_id: Some(request_id),
            msg_type: None,
            error: Some(error),
            data: None,
            extra: Map::new(),
        }
    }

    /// Error reply to a frame that may not carry a `requestId` (e.g. one that
    /// failed to parse). Serializes as `{requestId?, error}`.
    pub fn error_reply(request_id: Option<String>, error: String) -> Self {
        Self {
            request_id,
            msg_type: None,
            error: Some(error),
            data: None,
            extra: Map::new(),
        }
    }

    /// Server-initiated notification (no response expected). `fields` should be a
    /// JSON object whose entries become top-level fields on the wire.
    pub fn notification(msg_type: &str, fields: Value) -> Self {
        let extra = match fields {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        Self {
            request_id: None,
            msg_type: Some(msg_type.to_string()),
            error: None,
            data: None,
            extra,
        }
    }
}

/// Transport connection data (`connectTransport`).
#[derive(Debug, Clone, Deserialize)]
pub struct ConnectTransportData {
    #[serde(rename = "transportId")]
    pub transport_id: String,

    #[serde(rename = "dtlsParameters")]
    pub dtls_parameters: Value,
}

/// Producer creation data (`produce`).
#[derive(Debug, Clone, Deserialize)]
pub struct ProduceData {
    #[serde(rename = "transportId")]
    pub transport_id: String,

    pub kind: String, // "audio" or "video"

    #[serde(rename = "rtpParameters")]
    pub rtp_parameters: Value,

    #[serde(rename = "appData", default)]
    pub app_data: Option<Value>,

    /// Create the producer paused (the client's track starts disabled, e.g.
    /// push-to-talk or a hidden camera), so it is never announced as live.
    #[serde(default)]
    pub paused: bool,
}

/// Consumer creation data (`consume`).
#[derive(Debug, Clone, Deserialize)]
pub struct ConsumeData {
    #[serde(rename = "transportId")]
    pub transport_id: String,

    #[serde(rename = "producerId")]
    pub producer_id: String,

    #[serde(rename = "rtpCapabilities")]
    pub rtp_capabilities: Value,
}

/// WebRTC transport creation data (`createWebRtcTransport`).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateWebRtcTransportData {
    pub producing: Option<bool>,
    pub consuming: Option<bool>,

    #[serde(rename = "sctpCapabilities", default)]
    pub sctp_capabilities: Option<Value>,
}

/// Transport creation response.
#[derive(Debug, Clone, Serialize)]
pub struct TransportCreatedResponse {
    pub id: String,

    #[serde(rename = "iceParameters")]
    pub ice_parameters: Value,

    #[serde(rename = "iceCandidates")]
    pub ice_candidates: Value,

    #[serde(rename = "dtlsParameters")]
    pub dtls_parameters: Value,

    #[serde(rename = "sctpParameters", skip_serializing_if = "Option::is_none")]
    pub sctp_parameters: Option<Value>,
}

/// Producer creation response.
#[derive(Debug, Clone, Serialize)]
pub struct ProducedResponse {
    pub id: String,
}

/// Consumer creation response.
#[derive(Debug, Clone, Serialize)]
pub struct ConsumedResponse {
    pub id: String,

    #[serde(rename = "producerId")]
    pub producer_id: String,

    pub kind: String,

    #[serde(rename = "rtpParameters")]
    pub rtp_parameters: Value,

    /// Whether the underlying producer is currently paused. The client mirrors
    /// this onto the consumer after resuming it.
    #[serde(rename = "producerPaused")]
    pub producer_paused: bool,
}

/// One entry of the `getProducers` response: a producer owned by another peer
/// in the caller's room. Same fields as the `newProducer` notification
/// (lowercase `kind`, current `paused` state).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProducerInfo {
    #[serde(rename = "producerId")]
    pub producer_id: String,

    #[serde(rename = "userId")]
    pub user_id: String,

    /// `"audio"` or `"video"`.
    pub kind: String,

    pub paused: bool,
}

/// `getProducers` response: `{producers: [ProducerInfo...]}`.
#[derive(Debug, Clone, Serialize)]
pub struct ProducersResponse {
    pub producers: Vec<ProducerInfo>,
}

/// `restartIce` response: `{iceParameters}`.
#[derive(Debug, Clone, Serialize)]
pub struct RestartIceResponse {
    #[serde(rename = "iceParameters")]
    pub ice_parameters: Value,
}
