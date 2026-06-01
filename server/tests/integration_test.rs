use mediasoup_server::{Config, IncomingMessage, MediaSoupServer, OutgoingMessage};
use serde_json::json;

#[tokio::test]
async fn test_server_startup() {
    // Create a test configuration
    let config = Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(), // Use random port
        http_addr: None,
        worker: mediasoup_server::config::WorkerConfig {
            num_workers: 1,
            log_level: "error".to_string(),
            log_tags: vec!["info".to_string()],
            rtc_min_port: 10000,
            rtc_max_port: 10010,
        },
        router: mediasoup_server::config::RouterConfig {
            media_codecs: vec![],
        },
        webrtc: mediasoup_server::config::WebRtcConfig {
            listen_ips: vec![mediasoup_server::config::ListenIp {
                ip: "127.0.0.1".to_string(),
                announced_ip: None,
            }],
        },
        auth_token: None,
        tls: None,
    };

    // Test that server can be created
    let server = MediaSoupServer::new(config).await;
    assert!(server.is_ok(), "Failed to create MediaSoup server");
}

#[tokio::test]
async fn test_incoming_message_deserialization() {
    // The client sends a flat envelope: { type, requestId, userId, <payload...> }.
    let raw = r#"{
        "type": "produce",
        "requestId": "req_3",
        "userId": "user-1",
        "transportId": "transport-7",
        "kind": "audio"
    }"#;

    let message: IncomingMessage =
        serde_json::from_str(raw).expect("Failed to deserialize incoming message");

    assert_eq!(message.msg_type, "produce");
    assert_eq!(message.request_id.as_deref(), Some("req_3"));
    assert_eq!(message.user_id.as_deref(), Some("user-1"));

    // Remaining top-level fields are captured in the flattened payload.
    let payload = message.payload_value();
    assert_eq!(payload["transportId"], "transport-7");
    assert_eq!(payload["kind"], "audio");
    // The envelope fields are not duplicated into the payload.
    assert!(payload.get("type").is_none());
    assert!(payload.get("requestId").is_none());
}

#[tokio::test]
async fn test_outgoing_response_serialization() {
    // A successful response carries the correlating requestId and a data payload.
    let response = OutgoingMessage::response("req_3".to_string(), json!({ "id": "producer-123" }));
    let value = serde_json::to_value(&response).expect("Failed to serialize response");

    assert_eq!(value["requestId"], "req_3");
    assert_eq!(value["data"]["id"], "producer-123");
    // No notification or error fields leak into a response.
    assert!(value.get("type").is_none());
    assert!(value.get("error").is_none());

    // An error response carries the error string instead of data.
    let error = OutgoingMessage::error("req_4".to_string(), "boom".to_string());
    let error_value = serde_json::to_value(&error).expect("Failed to serialize error");
    assert_eq!(error_value["requestId"], "req_4");
    assert_eq!(error_value["error"], "boom");
    assert!(error_value.get("data").is_none());
}

#[tokio::test]
async fn test_outgoing_notification_serialization() {
    // Notifications use a top-level `type` plus flat fields the client reads
    // directly (producerId, userId, kind).
    let notification = OutgoingMessage::notification(
        "newProducer",
        json!({
            "producerId": "producer-123",
            "userId": "user-456",
            "kind": "video"
        }),
    );

    let value = serde_json::to_value(&notification).expect("Failed to serialize notification");

    assert_eq!(value["type"], "newProducer");
    assert_eq!(value["producerId"], "producer-123");
    assert_eq!(value["userId"], "user-456");
    assert_eq!(value["kind"], "video");
    // A notification has no requestId (it does not expect a response).
    assert!(value.get("requestId").is_none());
}
