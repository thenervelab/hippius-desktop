//! Boot-time startup of the Finder bridge on macOS.
//!
//! Called once from `setup()`. The body runs inside the Tauri async runtime
//! because `tokio::net::UnixListener::bind` needs a reactor in scope. Best-
//! effort: a missing container path or a bind failure disables Finder
//! integration but never blocks app launch.

use tauri::{AppHandle, Manager};
use tracing::{info, warn};

use crate::app_state::AppState;
use crate::finder_bridge::{container, socket::FinderBridge};

/// Start the Finder bridge: bind the App Group socket, store the handle in
/// [`AppState`], and drain inbound menu-click messages.
///
/// Phase 1 stub: the drain handler only logs each click. The Phase 2 share
/// dispatch (resolve path → mint / upload / zip + password wrap) replaces it.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let socket_path = match container::socket_path() {
            Ok(path) => path,
            Err(e) => {
                warn!(error = %e, "finder bridge: cannot resolve App Group container; not starting");
                return;
            }
        };
        let (bridge, mut incoming) = match FinderBridge::start(socket_path.clone()) {
            Ok(pair) => pair,
            Err(e) => {
                warn!(error = %e, path = %socket_path.display(), "finder bridge: failed to start; Finder integration disabled");
                return;
            }
        };

        // The State guard is dropped at the end of this statement, never held
        // across the await loop below.
        if app.state::<AppState>().set_finder_bridge(bridge).is_err() {
            warn!("finder bridge: already started; ignoring duplicate start");
            return;
        }
        info!(path = %socket_path.display(), "finder bridge: listening for the Finder extension");

        // Phase 1 stub dispatcher: log each menu action. The loop ends when the
        // bridge handle is dropped (process exit), which closes the channel.
        while let Some(action) = incoming.recv().await {
            info!(?action, "finder bridge: inbound menu action (stub — share dispatch lands in Phase 2)");
        }
        info!("finder bridge: inbound channel closed");
    });
}
