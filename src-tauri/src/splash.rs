//! Splash-screen lifecycle commands.
//!
//! Until 2026-05 the splash's terminal "Launching App" phase invoked
//! `nebula::manager::finish_setup`, which kicked off Nebula auto-start.
//! After Nebula removal there is no terminal work, but the splash UI
//! still expects a command to await before transitioning off-screen —
//! hence this no-op stub. Keeping the command (instead of dropping the
//! invoke from the FE) lets the splash retain its existing two-beat
//! shape without conditional logic.
//!
//! The command is named `finish_splash` (not `finish_setup`) to avoid
//! a Tauri `generate_handler!` collision while the Nebula module still
//! exposes `nebula::manager::finish_setup`. Once Nebula is fully removed
//! in a later unit the name can stay — `finish_splash` is the more
//! accurate description of what this handshake actually represents.

/// Splash terminal handshake. Always succeeds; exists so the FE has a
/// command to await before dismissing the splash.
#[tauri::command]
pub async fn finish_splash() -> Result<(), String> {
    Ok(())
}
