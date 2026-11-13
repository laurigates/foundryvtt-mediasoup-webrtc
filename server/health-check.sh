#!/bin/sh
# Health check for the MediaSoup signaling server: is the WebSocket port
# accepting TCP connections? (A WebSocket-level check would need a full
# handshake.) Host and port come from MEDIASOUP_LISTEN_ADDR, like the server,
# with the same default (0.0.0.0:3000).

addr="${MEDIASOUP_LISTEN_ADDR:-0.0.0.0:3000}"
port="${addr##*:}"
host="${addr%:*}"
host="${host#[}"
host="${host%]}"

case "$port" in
    '' | *[!0-9]*) port=3000 ;;
esac
# A wildcard bind is reachable on loopback.
case "$host" in
    '' | 0.0.0.0 | ::) host=localhost ;;
esac

if nc -z "$host" "$port"; then
    exit 0
else
    exit 1
fi
