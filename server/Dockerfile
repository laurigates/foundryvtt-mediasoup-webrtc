# Multi-stage build for optimized production image
FROM rust:1.82-bullseye AS builder

# Install system dependencies needed by mediasoup-sys
RUN apt-get update && apt-get install -y \
    python3-pip \
    python3-dev \
    build-essential \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Install rustfmt which is needed by mediasoup-sys build script
RUN rustup component add rustfmt

# Create app directory
WORKDIR /app

# Copy manifests
COPY Cargo.toml Cargo.lock ./

# Create a dummy main.rs to build dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs

# Build dependencies
RUN cargo build --release && rm -rf src target/release/deps/mediasoup_server*

# Copy source code
COPY src ./src

# Build application
RUN cargo build --release

# Runtime stage
FROM debian:bullseye-slim

# Install runtime dependencies including netcat for health checks
RUN apt-get update && apt-get install -y \
    ca-certificates \
    netcat \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r mediasoup && useradd -r -g mediasoup mediasoup

# Create directories
RUN mkdir -p /app && chown mediasoup:mediasoup /app

# Copy binary
COPY --from=builder /app/target/release/mediasoup-server /usr/local/bin/mediasoup-server
RUN chmod +x /usr/local/bin/mediasoup-server

# Copy health check script
COPY health-check.sh /usr/local/bin/health-check.sh
RUN chmod +x /usr/local/bin/health-check.sh

# Switch to non-root user
USER mediasoup
WORKDIR /app

# Expose ports
EXPOSE 4443
EXPOSE 10000-10100/udp

# Health check - use script to check if port is listening
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD /usr/local/bin/health-check.sh

# Run the application
CMD ["mediasoup-server"]