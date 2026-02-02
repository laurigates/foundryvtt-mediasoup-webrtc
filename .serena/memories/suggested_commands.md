# Suggested Commands

## Development Setup

```bash
# Install dependencies
npm install

# Install Playwright browsers (for testing)
npm run test:install
```

## Building

```bash
# Production build
npm run build

# Development build with file watching
npm run dev
# or
npm run build:watch

# Build test bundle
npm run build:test

# Clean build directory
npm run clean

# Create distribution package (zip)
npm run package
```

## Code Quality

```bash
# Lint code
npm run lint

# Fix linting issues automatically
npm run lint:fix
```

## Testing

### JavaScript/Integration Tests (Playwright)

```bash
# Run all tests
npm test

# Run integration tests only
npm run test:integration

# Run tests with browser UI visible
npm run test:headed

# Run tests in debug mode
npm run test:debug
```

### Rust Server Tests

```bash
# Run server tests
npm run test:server
# or directly
cd server && cargo test
```

### Docker-based Testing

```bash
# Start all test services
docker-compose -f docker-compose.test.yml up

# Run only the MediaSoup server for local testing
docker-compose -f docker-compose.test.yml up mediasoup-server
```

## Server Development

```bash
# Build and run the Rust server
cd server && cargo run --release

# Check Rust code
cd server && cargo check

# Format Rust code
cd server && cargo fmt

# Lint Rust code
cd server && cargo clippy
```

## Module Installation

```bash
# Method 1: Copy built dist/ to FoundryVTT modules directory
cp -r dist/ /foundrydata/Data/modules/mediasoup-vtt/

# Method 2: Symlink for development
ln -s /path/to/repo /foundrydata/Data/modules/mediasoup-vtt/
```

## Manifest Processing

```bash
# Process module.json template
npm run process-template
```

## Debugging

```bash
# Enable verbose WebRTC logging
WEBRTC_DEBUG=true npm run test:integration

# Enable Playwright debug logs
DEBUG=pw:* npm run test:integration

# Enable Rust server debug logs
RUST_LOG=debug cargo run
```

## Git Operations

```bash
# Standard git commands (Linux)
git status
git add <files>
git commit -m "message"
git push origin <branch>
git pull origin <branch>
```

## System Utilities (Linux)

```bash
# List files
ls -la

# Find files
find . -name "pattern"

# Search in files
grep -r "pattern" .

# Check port availability
lsof -i :4443
```
