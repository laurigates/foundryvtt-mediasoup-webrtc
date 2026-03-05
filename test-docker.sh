#!/bin/bash
# Test script for Docker integration

echo "🐳 Docker Integration Test"
echo "========================="

# Clean up previous test runs
echo "Cleaning up previous containers..."
docker compose -f docker-compose.test.yml down -v 2>/dev/null

# Build the MediaSoup server
echo ""
echo "Building MediaSoup server..."
if docker compose -f docker-compose.test.yml build mediasoup-server; then
    echo "✅ MediaSoup server build successful"
else
    echo "❌ MediaSoup server build failed"
    exit 1
fi

# Start the services
echo ""
echo "Starting services..."
docker compose -f docker-compose.test.yml up -d mediasoup-server test-server

# Wait for services to be ready
echo "Waiting for services to be ready..."
sleep 5

# Check service health
echo ""
echo "Checking service health..."
if docker compose -f docker-compose.test.yml ps | grep -q "healthy"; then
    echo "✅ MediaSoup server is healthy"
else
    echo "❌ MediaSoup server is not healthy"
    docker compose -f docker-compose.test.yml logs mediasoup-server
    exit 1
fi

# Test WebSocket endpoint
echo ""
echo "Testing WebSocket endpoint..."
# WebSocket servers typically return a 400 or don't respond to plain HTTP requests
# We'll just check if the port is open
if nc -zv localhost 4443 2>&1 | grep -q "open"; then
    echo "✅ WebSocket endpoint port is open and listening"
else
    echo "❌ WebSocket endpoint is not responding"
    exit 1
fi

# Test HTTP server
echo ""
echo "Testing HTTP test server..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200"; then
    echo "✅ HTTP test server is responding"
else
    echo "❌ HTTP test server is not responding"
    exit 1
fi

echo ""
echo "🎉 All Docker integration tests passed!"
echo ""
echo "To run full Playwright tests, use:"
echo "  docker compose -f docker-compose.test.yml run --rm playwright-tests"

# Clean up
echo ""
echo "Cleaning up..."
docker compose -f docker-compose.test.yml down

exit 0