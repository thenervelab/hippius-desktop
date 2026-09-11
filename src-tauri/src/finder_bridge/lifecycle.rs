//! Boot-time startup of the Finder bridge on macOS.
//!
//! Called once from `setup()`. The body runs inside the Tauri async runtime
//! because `tokio::net::UnixListener::bind` needs a reactor in scope. Best-
//! effort: a missing container path or a bind failure disables Finder
//! integration but never blocks app launch.

use tauri::{AppHandle, Manager};
use tracing::{info, warn};

use crate::app_state::AppState;
use crate::finder_bridge::{endpoint, socket::FinderBridge};

/// Start the Finder bridge: bind the platform transport, store the handle in
/// [`AppState`], and drain inbound menu-click messages to the share dispatch.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let endpoint = match endpoint::resolve() {
            Ok(endpoint) => endpoint,
            Err(e) => {
                warn!(error = %e, "finder bridge: cannot resolve transport endpoint; not starting");
                return;
            }
        };
        let (bridge, mut incoming) = match FinderBridge::start(endpoint) {
            Ok(pair) => pair,
            Err(e) => {
                warn!(error = %e, "finder bridge: failed to start; Finder integration disabled");
                return;
            }
        };

        // The State guard is dropped at the end of this statement, never held
        // across the await loop below.
        if app.state::<AppState>().set_finder_bridge(bridge).is_err() {
            warn!("finder bridge: already started; ignoring duplicate start");
            return;
        }
        info!("finder bridge: listening for the file-manager extension");

        // SHARE is a user click that may hit the network — spawn so it cannot
        // stall the next click. BADGE_QUERY is one line per visible Finder
        // row and is answered from in-memory state; run it on this task so
        // a scroll cannot spawn unbounded work.
        while let Some(action) = incoming.recv().await {
            let spawn_share = match &action {
                crate::finder_bridge::protocol::ClientMessage::Share(_) => true,
                crate::finder_bridge::protocol::ClientMessage::BadgeQuery(_) => false,
            };
            if spawn_share {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::finder_bridge::dispatch::handle(app, action).await;
                });
            } else {
                crate::finder_bridge::dispatch::handle(app.clone(), action).await;
            }
        }
        info!("finder bridge: inbound channel closed");
    });
}
