//! End-to-end signaling tests: start the real server (with a real mediasoup
//! worker) on `127.0.0.1:0` and drive it with tokio-tungstenite clients using
//! the same wire contract as the FoundryVTT client (`src/constants/index.ts`).
//!
//! No media flows here (there is no DTLS/ICE peer); these tests pin the
//! signaling state machine: auth, room routing, transports, produce/consume,
//! late-join `getProducers`, `closeProducer` -> `producerClosed`, error
//! replies, eviction and keepalive.

use futures_util::{SinkExt, StreamExt};
use mediasoup_server::config::{ListenIp, RouterConfig, WebRtcConfig, WorkerConfig};
use mediasoup_server::{Config, MediaSoupServer};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const TOKEN: &str = "e2e-shared-secret";
const ROOM: &str = "world-e2e";
const STEP_TIMEOUT: Duration = Duration::from_secs(10);

fn test_config() -> Config {
    Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        http_addr: None,
        worker: WorkerConfig {
            num_workers: 1,
            log_level: "warn".to_string(),
            log_tags: vec![],
            rtc_min_port: 40000,
            rtc_max_port: 40999,
        },
        router: RouterConfig {
            media_codecs: vec![],
        },
        webrtc: WebRtcConfig {
            listen_ips: vec![ListenIp {
                ip: "127.0.0.1".to_string(),
                announced_ip: None,
            }],
            enable_udp: true,
            enable_tcp: true,
            prefer_udp: true,
            allow_unannounced: false,
        },
        auth_token: Some(TOKEN.to_string()),
        tls: None,
    }
}

/// Start a server on an ephemeral loopback port and return its address.
async fn start_server_with(keepalive: Option<(Duration, u32)>) -> SocketAddr {
    let config = test_config();
    config.validate().expect("test config is valid");
    let mut server = MediaSoupServer::new(config)
        .await
        .expect("failed to create server (is the mediasoup worker built?)");
    if let Some((interval, max_missed)) = keepalive {
        server = server.with_keepalive(interval, max_missed);
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        if let Err(e) = server.run_with_listener(listener).await {
            panic!("server exited: {e}");
        }
    });
    addr
}

async fn start_server() -> SocketAddr {
    start_server_with(None).await
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// A minimal signaling client: correlates responses by `requestId` and
/// buffers notifications that arrive in between.
struct Client {
    name: &'static str,
    ws: Ws,
    next_id: u32,
    notifications: VecDeque<Value>,
}

impl Client {
    async fn connect(addr: SocketAddr, name: &'static str) -> Self {
        let (ws, _) = tokio::time::timeout(STEP_TIMEOUT, connect_async(format!("ws://{addr}")))
            .await
            .expect("connect timed out")
            .expect("connect failed");
        Self {
            name,
            ws,
            next_id: 0,
            notifications: VecDeque::new(),
        }
    }

    /// Connect and authenticate into `room` as `user_id`.
    async fn join(addr: SocketAddr, name: &'static str, user_id: &str, room: &str) -> Self {
        let mut client = Self::connect(addr, name).await;
        let data = client
            .request(
                "authenticate",
                json!({ "token": TOKEN, "userId": user_id, "roomId": room }),
            )
            .await
            .unwrap_or_else(|e| panic!("{name}: authenticate failed: {e}"));
        assert_eq!(data, json!({}), "{name}: authenticate returns {{}}");
        client
    }

    async fn send_text(&mut self, text: String) {
        self.ws
            .send(Message::Text(text.into()))
            .await
            .unwrap_or_else(|e| panic!("{}: send failed: {e}", self.name));
    }

    /// Next JSON text frame (skipping ping/pong). Panics on timeout or close.
    async fn recv_json(&mut self) -> Value {
        loop {
            let frame = tokio::time::timeout(STEP_TIMEOUT, self.ws.next())
                .await
                .unwrap_or_else(|_| panic!("{}: timed out waiting for a frame", self.name))
                .unwrap_or_else(|| panic!("{}: connection closed", self.name))
                .unwrap_or_else(|e| panic!("{}: websocket error: {e}", self.name));
            match frame {
                Message::Text(text) => {
                    return serde_json::from_str(&text)
                        .unwrap_or_else(|e| panic!("{}: bad JSON from server: {e}", self.name));
                }
                Message::Close(frame) => panic!("{}: server closed: {frame:?}", self.name),
                _ => continue,
            }
        }
    }

    /// Send `{type, requestId, userId?, ...fields}` and wait for the matching
    /// response. Returns `data` on success or the `error` string.
    async fn request(&mut self, msg_type: &str, fields: Value) -> Result<Value, String> {
        self.next_id += 1;
        let request_id = format!("{}_req_{}", self.name, self.next_id);
        let mut frame = fields.as_object().cloned().unwrap_or_default();
        frame.insert("type".into(), json!(msg_type));
        frame.insert("requestId".into(), json!(request_id));
        self.send_text(Value::Object(frame).to_string()).await;

        loop {
            let message = self.recv_json().await;
            if message.get("requestId").and_then(Value::as_str) == Some(request_id.as_str()) {
                if let Some(error) = message.get("error") {
                    return Err(error.as_str().unwrap_or_default().to_string());
                }
                return Ok(message.get("data").cloned().unwrap_or(Value::Null));
            }
            assert!(
                message.get("requestId").is_none(),
                "{}: response for an unexpected request: {message}",
                self.name
            );
            self.notifications.push_back(message);
        }
    }

    async fn ok(&mut self, msg_type: &str, fields: Value) -> Value {
        self.request(msg_type, fields)
            .await
            .unwrap_or_else(|e| panic!("{}: {msg_type} failed: {e}", self.name))
    }

    async fn err(&mut self, msg_type: &str, fields: Value) -> String {
        match self.request(msg_type, fields).await {
            Ok(data) => panic!("{}: {msg_type} unexpectedly succeeded: {data}", self.name),
            Err(e) => e,
        }
    }

    /// Wait for a notification of `msg_type` (buffered or incoming).
    async fn notification(&mut self, msg_type: &str) -> Value {
        if let Some(pos) = self
            .notifications
            .iter()
            .position(|n| n["type"] == msg_type)
        {
            return self.notifications.remove(pos).unwrap();
        }
        loop {
            let message = self.recv_json().await;
            if message["type"] == msg_type {
                return message;
            }
            self.notifications.push_back(message);
        }
    }

    /// Create and connect a WebRTC transport, returning its full response.
    async fn transport(&mut self, producing: bool) -> Value {
        let transport = self
            .ok(
                "createWebRtcTransport",
                json!({ "producing": producing, "consuming": !producing }),
            )
            .await;
        let transport_id = transport["id"].as_str().expect("transport id").to_string();
        self.ok(
            "connectTransport",
            json!({ "transportId": transport_id, "dtlsParameters": client_dtls_parameters() }),
        )
        .await;
        transport
    }
}

/// DTLS parameters as mediasoup-client sends them in `connectTransport`.
fn client_dtls_parameters() -> Value {
    json!({
        "role": "client",
        "fingerprints": [{
            "algorithm": "sha-256",
            "value": "82:5A:68:3D:36:C3:0A:DE:AF:E7:32:43:D2:88:83:57:AC:2D:65:E5:80:C4:B6:FB:AF:1A:A0:21:9F:6D:0C:AD"
        }]
    })
}

/// RTP parameters shaped like what mediasoup-client sends for a Chrome Opus
/// microphone track (`produce` request).
fn browser_opus_rtp_parameters() -> Value {
    json!({
        "mid": "0",
        "codecs": [{
            "mimeType": "audio/opus",
            "payloadType": 111,
            "clockRate": 48000,
            "channels": 2,
            "parameters": { "minptime": 10, "useinbandfec": 1, "sprop-stereo": 0, "usedtx": 1 },
            "rtcpFeedback": [{ "type": "transport-cc", "parameter": "" }]
        }],
        "headerExtensions": [
            { "uri": "urn:ietf:params:rtp-hdrext:sdes:mid", "id": 4, "encrypt": false, "parameters": {} },
            { "uri": "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time", "id": 2, "encrypt": false, "parameters": {} },
            { "uri": "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01", "id": 3, "encrypt": false, "parameters": {} },
            { "uri": "urn:ietf:params:rtp-hdrext:ssrc-audio-level", "id": 1, "encrypt": false, "parameters": {} }
        ],
        "encodings": [{ "ssrc": 1_234_567_890u32, "dtx": false }],
        "rtcp": { "cname": "Qk1rTzBxdmlPc2Y0", "reducedSize": true }
    })
}

/// The full A/B scenario from the plan's 3A acceptance.
#[tokio::test]
async fn late_joiner_consumes_and_sees_producer_closed() {
    let addr = start_server().await;

    // --- A joins, sets up a send transport and produces audio.
    let mut a = Client::join(addr, "A", "user-a", ROOM).await;
    let caps = a.ok("getRouterRtpCapabilities", json!({})).await;
    assert!(
        caps["codecs"]
            .as_array()
            .is_some_and(|c| c.iter().any(|c| c["mimeType"] == "audio/opus")),
        "router offers Opus: {caps}"
    );

    let send_transport = a.transport(true).await;
    for key in ["id", "iceParameters", "iceCandidates", "dtlsParameters"] {
        assert!(
            send_transport.get(key).is_some(),
            "createWebRtcTransport response has {key}: {send_transport}"
        );
    }
    let candidates = send_transport["iceCandidates"].as_array().unwrap();
    let protocols: Vec<&str> = candidates
        .iter()
        .map(|c| c["protocol"].as_str().unwrap_or_default())
        .collect();
    assert!(protocols.contains(&"udp"), "UDP candidate: {candidates:?}");
    assert!(protocols.contains(&"tcp"), "TCP candidate: {candidates:?}");
    assert!(
        candidates.iter().all(|c| c["address"] == "127.0.0.1"),
        "candidates use the configured listen IP: {candidates:?}"
    );
    let send_transport_id = send_transport["id"].as_str().unwrap().to_string();

    let produced = a
        .ok(
            "produce",
            json!({
                "transportId": send_transport_id,
                "kind": "audio",
                "rtpParameters": browser_opus_rtp_parameters(),
                "appData": { "source": "mic" }
            }),
        )
        .await;
    let producer_id = produced["id"].as_str().expect("producer id").to_string();

    // A never sees its own producer.
    let own = a.ok("getProducers", json!({})).await;
    assert_eq!(own, json!({ "producers": [] }));

    // --- A peer in a different room (another world) is isolated.
    let mut other = Client::join(addr, "C", "user-c", "some-other-world").await;
    assert_eq!(
        other.ok("getProducers", json!({})).await,
        json!({ "producers": [] }),
        "rooms are routed by roomId"
    );

    // --- B joins late and discovers A's producer via getProducers.
    let mut b = Client::join(addr, "B", "user-b", ROOM).await;
    let listed = b.ok("getProducers", json!({})).await;
    assert_eq!(
        listed,
        json!({ "producers": [{
            "producerId": producer_id,
            "userId": "user-a",
            "kind": "audio",
            "paused": false
        }] })
    );

    // --- B consumes and resumes.
    let b_caps = b.ok("getRouterRtpCapabilities", json!({})).await;
    let recv_transport = b.transport(false).await;
    let recv_transport_id = recv_transport["id"].as_str().unwrap().to_string();
    let consumed = b
        .ok(
            "consume",
            json!({
                "transportId": recv_transport_id,
                "producerId": producer_id,
                "rtpCapabilities": b_caps
            }),
        )
        .await;
    assert_eq!(consumed["producerId"], producer_id.as_str());
    assert_eq!(consumed["kind"], "audio");
    assert_eq!(consumed["producerPaused"], false);
    assert!(consumed["rtpParameters"]["codecs"].is_array());
    let consumer_id = consumed["id"].as_str().expect("consumer id").to_string();
    assert_eq!(
        b.ok("consumerResume", json!({ "consumerId": consumer_id }))
            .await,
        json!({})
    );

    // Pause state is pushed to consumers and reflected in getProducers.
    a.ok("pauseProducer", json!({ "producerId": producer_id }))
        .await;
    assert_eq!(
        b.notification("producerPaused").await,
        json!({ "type": "producerPaused", "producerId": producer_id })
    );
    let listed = b.ok("getProducers", json!({})).await;
    assert_eq!(listed["producers"][0]["paused"], true);
    a.ok("resumeProducer", json!({ "producerId": producer_id }))
        .await;
    assert_eq!(
        b.notification("producerResumed").await,
        json!({ "type": "producerResumed", "producerId": producer_id })
    );

    // closeConsumer on a second consumer of the same producer.
    let second = b
        .ok(
            "consume",
            json!({
                "transportId": recv_transport_id,
                "producerId": producer_id,
                "rtpCapabilities": b_caps
            }),
        )
        .await;
    let second_id = second["id"].as_str().unwrap().to_string();
    assert_eq!(
        b.ok("closeConsumer", json!({ "consumerId": second_id }))
            .await,
        json!({})
    );
    let e = b
        .err("closeConsumer", json!({ "consumerId": second_id }))
        .await;
    assert!(e.contains("Consumer not found"), "{e}");

    // restartIce returns fresh ICE parameters.
    let restarted = a
        .ok("restartIce", json!({ "transportId": send_transport_id }))
        .await;
    let ice = &restarted["iceParameters"];
    assert!(ice["usernameFragment"].is_string(), "{restarted}");
    assert!(ice["password"].is_string(), "{restarted}");
    assert_ne!(
        ice["usernameFragment"], send_transport["iceParameters"]["usernameFragment"],
        "ICE credentials changed"
    );

    // Only the owner can close a producer.
    let e = b
        .err("closeProducer", json!({ "producerId": producer_id }))
        .await;
    assert!(e.contains("Producer not found"), "{e}");

    // --- A closes its producer; B is told.
    assert_eq!(
        a.ok("closeProducer", json!({ "producerId": producer_id }))
            .await,
        json!({})
    );
    let closed = b.notification("producerClosed").await;
    assert_eq!(
        closed,
        json!({ "type": "producerClosed", "producerId": producer_id })
    );
    assert_eq!(
        b.ok("getProducers", json!({})).await,
        json!({ "producers": [] })
    );

    // The server dropped B's consumer when its producer closed.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let e = b
            .err("consumerResume", json!({ "consumerId": consumer_id }))
            .await;
        if e.contains("Consumer not found") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "consumer was not cleaned up after its producer closed (last error: {e})"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // --- Unknown ids and methods get error replies.
    let e = a
        .err("closeProducer", json!({ "producerId": producer_id }))
        .await;
    assert!(e.contains("Producer not found"), "{e}");
    let e = a
        .err("closeProducer", json!({ "producerId": "no-such-producer" }))
        .await;
    assert!(e.contains("Producer not found"), "{e}");
    let e = b
        .err("closeConsumer", json!({ "consumerId": "no-such-consumer" }))
        .await;
    assert!(e.contains("Consumer not found"), "{e}");
    let e = b
        .err("restartIce", json!({ "transportId": "no-such-transport" }))
        .await;
    assert!(e.contains("Transport not found"), "{e}");
    let e = b
        .err(
            "consume",
            json!({
                "transportId": recv_transport_id,
                "producerId": "no-such-producer",
                "rtpCapabilities": b_caps
            }),
        )
        .await;
    assert!(e.contains("Producer not found"), "{e}");
    let e = b.err("closeProducer", json!({})).await;
    assert!(e.contains("Missing producerId"), "{e}");
    let e = b.err("noSuchMethod", json!({})).await;
    assert!(e.contains("Unknown method"), "{e}");

    // --- Malformed frames get an error reply (with requestId when present).
    b.send_text(r#"{"type": 42, "requestId": "bad-1"}"#.to_string())
        .await;
    let reply = b.recv_json().await;
    assert_eq!(reply["requestId"], "bad-1", "{reply}");
    assert!(reply["error"].is_string(), "{reply}");
    assert!(reply.get("data").is_none(), "{reply}");

    b.send_text(r#"{"requestId": "bad-2"}"#.to_string()).await;
    let reply = b.recv_json().await;
    assert_eq!(reply["requestId"], "bad-2", "missing type: {reply}");
    assert!(reply["error"].is_string(), "{reply}");

    b.send_text("this is not json".to_string()).await;
    let reply = b.recv_json().await;
    assert!(reply.get("requestId").is_none(), "{reply}");
    assert!(
        reply["error"]
            .as_str()
            .is_some_and(|e| e.contains("invalid JSON")),
        "{reply}"
    );

    // The connection survives malformed frames.
    assert_eq!(
        b.ok("getProducers", json!({})).await,
        json!({ "producers": [] })
    );

    // A never received its own producerClosed.
    assert!(
        a.notifications
            .iter()
            .all(|n| n["type"] != "producerClosed"),
        "{:?}",
        a.notifications
    );
    drop(other);
}

/// When a producing peer disconnects, the rest of the room gets
/// `producerClosed` for each of its producers.
#[tokio::test]
async fn disconnect_announces_producer_closed() {
    let addr = start_server().await;
    let mut b = Client::join(addr, "B", "user-b", ROOM).await;
    let mut a = Client::join(addr, "A", "user-a", ROOM).await;
    let transport = a.transport(true).await;
    let producer_id = a
        .ok(
            "produce",
            json!({
                "transportId": transport["id"],
                "kind": "audio",
                "rtpParameters": browser_opus_rtp_parameters()
            }),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();

    let announced = b.notification("newProducer").await;
    assert_eq!(
        announced,
        json!({ "type": "newProducer", "producerId": producer_id, "userId": "user-a", "kind": "audio", "paused": false })
    );

    a.ws.close(None).await.expect("close");
    let closed = b.notification("producerClosed").await;
    assert_eq!(closed["producerId"], producer_id.as_str());
}

/// A second connection for the same user in the same room evicts the first:
/// the old socket is closed with code 4001 and its producers are announced
/// closed to the rest of the room.
#[tokio::test]
async fn duplicate_user_evicts_older_connection() {
    let addr = start_server().await;
    let mut b = Client::join(addr, "B", "user-b", ROOM).await;
    let mut old = Client::join(addr, "A1", "user-a", ROOM).await;
    let transport = old.transport(true).await;
    let producer_id = old
        .ok(
            "produce",
            json!({
                "transportId": transport["id"],
                "kind": "audio",
                "rtpParameters": browser_opus_rtp_parameters()
            }),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    b.notification("newProducer").await;

    let mut new = Client::join(addr, "A2", "user-a", ROOM).await;

    let closed = b.notification("producerClosed").await;
    assert_eq!(closed["producerId"], producer_id.as_str());

    // The old socket receives a 4001 close frame.
    let close_frame = loop {
        let frame = tokio::time::timeout(STEP_TIMEOUT, old.ws.next())
            .await
            .expect("timed out waiting for close")
            .expect("stream ended without a close frame")
            .expect("websocket error");
        if let Message::Close(frame) = frame {
            break frame.expect("close frame has a code");
        }
    };
    assert_eq!(close_frame.code, CloseCode::from(4001));

    // The new connection is fully functional and sees B's (empty) producers.
    assert_eq!(
        new.ok("getProducers", json!({})).await,
        json!({ "producers": [] })
    );
    // B still sees exactly one user-a peer's producers (none now).
    assert_eq!(
        b.ok("getProducers", json!({})).await,
        json!({ "producers": [] })
    );
}

/// A reconnect (`reconnect: true`) replaces only its own session's stale
/// connection. An older tab's backoff loop must not evict the newer tab that
/// took over; its authenticate is refused instead. A producer can start paused.
#[tokio::test]
async fn reconnect_does_not_evict_a_newer_session() {
    let addr = start_server().await;
    let auth = |session: &str, reconnect: bool| {
        json!({ "token": TOKEN, "userId": "user-a", "roomId": ROOM,
                "sessionId": session, "reconnect": reconnect })
    };
    let mut b = Client::join(addr, "B", "user-b", ROOM).await;

    let mut tab1 = Client::connect(addr, "tab1").await;
    tab1.ok("authenticate", auth("tab-1", false)).await;
    // The same session re-joining (its old socket went half-dead) replaces it.
    let mut tab1_again = Client::connect(addr, "tab1-again").await;
    tab1_again.ok("authenticate", auth("tab-1", true)).await;
    // A new tab takes over.
    let mut tab2 = Client::connect(addr, "tab2").await;
    tab2.ok("authenticate", auth("tab-2", false)).await;
    // The first tab's backoff loop is refused rather than evicting tab 2.
    let mut late = Client::connect(addr, "tab1-late").await;
    let e = late.err("authenticate", auth("tab-1", true)).await;
    assert!(e.contains("another session"), "{e}");

    // Tab 2 still works, and its producer can be born paused.
    let transport = tab2.transport(true).await;
    let produced = tab2
        .ok(
            "produce",
            json!({
                "transportId": transport["id"],
                "kind": "audio",
                "rtpParameters": browser_opus_rtp_parameters(),
                "paused": true
            }),
        )
        .await;
    let announced = b.notification("newProducer").await;
    assert_eq!(announced["producerId"], produced["id"]);
    assert_eq!(announced["paused"], true);
    assert_eq!(
        b.ok("getProducers", json!({})).await["producers"][0]["paused"],
        true
    );
    drop((tab1, tab1_again));
}

/// Authentication is enforced before anything else.
#[tokio::test]
async fn authentication_is_required() {
    let addr = start_server().await;

    // Wrong token: error reply, then the server drops the connection.
    let mut bad = Client::connect(addr, "bad-token").await;
    let e = bad
        .request(
            "authenticate",
            json!({ "token": "wrong", "userId": "u", "roomId": ROOM }),
        )
        .await
        .expect_err("wrong token must fail");
    assert!(e.contains("Invalid authentication token"), "{e}");

    // A non-auth first message is rejected.
    let mut early = Client::connect(addr, "no-auth").await;
    let e = early
        .request("getProducers", json!({}))
        .await
        .expect_err("must authenticate first");
    assert!(e.contains("Authentication required"), "{e}");

    // An invalid roomId is rejected.
    let mut bad_room = Client::connect(addr, "bad-room").await;
    let e = bad_room
        .request(
            "authenticate",
            json!({ "token": TOKEN, "userId": "u", "roomId": 7 }),
        )
        .await
        .expect_err("numeric roomId must fail");
    assert!(e.contains("Invalid roomId"), "{e}");

    // A malformed first frame still gets a correlated error reply.
    let mut garbled = Client::connect(addr, "garbled").await;
    garbled
        .send_text(r#"{"type": ["authenticate"], "requestId": "auth-1"}"#.to_string())
        .await;
    let reply = garbled.recv_json().await;
    assert_eq!(reply["requestId"], "auth-1", "{reply}");
    assert!(reply["error"].is_string(), "{reply}");

    // Without roomId the client lands in the default room and works.
    let mut default_room = Client::connect(addr, "default-room").await;
    default_room
        .ok("authenticate", json!({ "token": TOKEN, "userId": "u" }))
        .await;
    assert_eq!(
        default_room.ok("getProducers", json!({})).await,
        json!({ "producers": [] })
    );
}

/// The server pings idle clients and drops ones that never answer, while a
/// client that keeps reading (and so auto-answers pings) stays connected.
#[tokio::test]
async fn keepalive_drops_unresponsive_peers() {
    let interval = Duration::from_millis(100);
    let addr = start_server_with(Some((interval, 3))).await;

    let mut live = Client::join(addr, "live", "user-live", ROOM).await;
    let mut dead = Client::join(addr, "dead", "user-dead", ROOM).await;

    // `live` keeps polling its socket (tungstenite answers pings on read);
    // `dead` does not read at all, so it never sends a pong.
    let poll_live = async {
        let deadline = tokio::time::Instant::now() + interval * 10;
        let mut pings = 0;
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some(Ok(Message::Ping(_)))) =
                tokio::time::timeout(interval, live.ws.next()).await
            {
                pings += 1;
            }
        }
        pings
    };
    let pings = poll_live.await;
    assert!(pings >= 3, "server pinged the live client ({pings} pings)");

    // The live client is still connected.
    assert_eq!(
        live.ok("getProducers", json!({})).await,
        json!({ "producers": [] })
    );

    // The dead client's stream ends (after any buffered pings).
    let ended = tokio::time::timeout(STEP_TIMEOUT, async {
        loop {
            match dead.ws.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "unresponsive peer was not dropped");
}
