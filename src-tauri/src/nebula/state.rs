//! Nebula VPN runtime state.

use std::sync::Mutex;

/// Nebula VPN runtime state — setup progress, background ping task, and the
/// owned child handle for the running `nebula` process (macOS/Windows only).
///
/// On Linux we spawn nebula via `setsid` so it detaches from our process tree
/// (prevents zombie reaping). The `Child` we get back is for `setsid` itself,
/// which immediately exec'd and exited — storing it would be useless. Linux
/// `stop_nebula` therefore stays on the `pkill` + `ps` polling path.
pub struct NebulaState {
    pub setup: Mutex<crate::nebula::manager::NebulaSetupState>,
    pub ping_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Owned tokio Child for the running nebula process. `Some` iff we are
    /// the parent of a non-detached nebula (macOS / Windows). Held under a
    /// tokio Mutex because reading/taking it crosses an `.await` (we wait
    /// on the child after kill).
    pub child: tokio::sync::Mutex<Option<tokio::process::Child>>,
}

impl Default for NebulaState {
    fn default() -> Self {
        Self::new()
    }
}

impl NebulaState {
    pub fn new() -> Self {
        Self {
            setup: Mutex::new(crate::nebula::manager::NebulaSetupState::default()),
            ping_handle: Mutex::new(None),
            child: tokio::sync::Mutex::new(None),
        }
    }
}
