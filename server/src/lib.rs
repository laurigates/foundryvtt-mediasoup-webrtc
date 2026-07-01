// The `WebSocket` variant of `MediaSoupError` embeds `tungstenite::Error`
// (~136 bytes), making the whole enum large. Boxing it to satisfy
// `clippy::result_large_err` would break the `#[from]` `?`-conversions used
// throughout the crate; the size is harmless on these error paths.
#![allow(clippy::result_large_err)]

pub mod config;
pub mod error;
pub mod room;
pub mod server;
pub mod signaling;

pub use config::Config;
pub use error::{MediaSoupError, Result};
pub use server::MediaSoupServer;
pub use signaling::{IncomingMessage, OutgoingMessage};
