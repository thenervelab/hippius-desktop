//! Substrate chain constants.

/// Default WebSocket endpoint for the Hippius parachain RPC node.
///
/// Used as the fallback when no custom endpoint is stored in the database.
/// Users can override this via the settings UI, which persists the new
/// endpoint in the `wss_endpoint` table.
pub const WSS_ENDPOINT: &str = "wss://rpc.hippius.network";
