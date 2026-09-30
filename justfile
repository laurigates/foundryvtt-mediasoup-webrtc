# foundryvtt-mediasoup-webrtc — task runner. Run `just` (or `just --list`) for recipes.

# Show available recipes.
default:
    @just --list

# Run the Vite dev server (proxies to Foundry on :30000 with HMR).
dev:
    bun run dev

# Build the ESM bundle + static assets to dist/.
build:
    bun run build

# Typecheck the TypeScript source (tsc --noEmit).
typecheck:
    bun run typecheck

# Lint TS/JSON with biome (no changes).
lint:
    bun run lint

# Auto-format + auto-fix with biome.
format:
    bun run lint:fix

# Run the Vitest unit suite.
test:
    bun run test

# Build the Rust SFU release binary the e2e suite runs (server/target/release/mediasoup-server).
server-build:
    cd server && cargo build --release

# Run the Playwright SFU e2e suite: the real bundle in Chromium (fake camera/mic) against the
# real SFU. Builds the bundle and the server first. PW_CHROMIUM_PATH overrides the browser.
test-e2e: build server-build
    bun run test:e2e

# Typecheck + build + lint + test — the local CI gate for the module.
check: typecheck build lint test

# Format, lint (clippy, -D warnings) and test the Rust SFU server.
server-check:
    cd server && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
