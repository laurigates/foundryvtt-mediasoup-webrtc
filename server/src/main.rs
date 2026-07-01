use anyhow::Result;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

// Consume the library crate rather than re-declaring the modules with `mod`,
// so the modules are compiled once (as the lib) and their public API is not
// re-analyzed as dead code in the binary's context.
use mediasoup_server::{Config, MediaSoupServer};

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .finish();
    tracing::subscriber::set_global_default(subscriber)?;

    info!("Starting MediaSoup server for FoundryVTT");

    // Load configuration
    let config = Config::load()?;
    info!("Loaded configuration: listening on {}", config.listen_addr);

    // Create and start the server
    let server = MediaSoupServer::new(config).await?;

    info!("MediaSoup server started successfully");

    // Run the server
    server.run().await?;

    Ok(())
}
