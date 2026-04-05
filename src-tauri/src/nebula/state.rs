//! Nebula VPN runtime state.

use std::sync::Mutex;

/// Nebula VPN runtime state — setup progress and background ping task.
pub struct NebulaState {
    pub setup: Mutex<crate::nebula::manager::NebulaSetupState>,
    pub ping_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
        }
    }
}
