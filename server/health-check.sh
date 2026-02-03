#!/bin/sh
# Health check script for MediaSoup WebSocket server
# Attempts a simple TCP connection check since WebSocket requires full handshake

# Check if port is listening
if nc -z localhost 4443; then
    exit 0
else
    exit 1
fi