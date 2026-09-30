# Multi-stage build for optimized production image.
#
# The mediasoup worker (built from C++ by the mediasoup-sys crate) needs a
# C++20 compiler and Python >= 3.10, so both stages use Debian bookworm.
FROM rust:1-bookworm AS builder

# System dependencies needed by the mediasoup-sys build script. It pip-installs
# `invoke`, `meson` and `ninja` into its own OUT_DIR with `pip install --target`.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip \
    python3-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# bookworm marks the system Python as externally managed (PEP 668); allow the
# build script's pip installs in this throwaway builder stage.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

# Install rustfmt which is needed by mediasoup-sys build script
RUN rustup component add rustfmt

# Create app directory
WORKDIR /app

# Copy manifests
COPY Cargo.toml Cargo.lock ./

# Create a dummy main.rs to build (and cache) dependencies, including the
# mediasoup worker, in their own layer.
RUN mkdir src && echo "fn main() {}" > src/main.rs

# Build dependencies
RUN cargo build --release && rm -rf src target/release/deps/mediasoup_server*

# Copy source code
COPY src ./src

# Build application. `touch` makes sure cargo sees the real sources as newer
# than the dummy build above (COPY preserves the context's mtimes).
RUN touch src/main.rs src/lib.rs && cargo build --release

# Runtime stage
FROM debian:bookworm-slim

# Install runtime dependencies including netcat for health checks
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    netcat-openbsd \
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
