use anyhow::Result;
use tracing::info;
use tracing_subscriber::EnvFilter;

// Consume the library crate rather than re-declaring the modules with `mod`,
// so the modules are compiled once (as the lib) and their public API is not
// re-analyzed as dead code in the binary's context.
use mediasoup_server::{Config, MediaSoupServer};

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing. `RUST_LOG` (e.g. `RUST_LOG=mediasoup_server=debug`)
    // overrides the default `info` level.
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .try_init()
        .map_err(|e| anyhow::anyhow!("failed to initialize tracing: {e}"))?;

    info!("Starting MediaSoup server for FoundryVTT");

    // Load configuration
    let config = Config::load()?;
    info!("Loaded configuration: listening on {}", config.listen_addr);

    // Refuse to start with a configuration that cannot carry media (e.g. a
    // 0.0.0.0 listen IP with no announced IP) instead of failing silently later.
    config.validate()?;

    // Create and start the server
    let server = MediaSoupServer::new(config).await?;

    info!("MediaSoup server started successfully");

    // Run the server
    server.run().await?;

    Ok(())
}
