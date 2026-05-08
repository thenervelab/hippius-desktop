//! Splash-screen lifecycle commands.
//!
//! The splash UI awaits a backend command before transitioning off-screen.
//! There is no real terminal work to do at this point — the splash runs
//! purely as a launch beat — so the handler is a no-op. Keeping the
//! command (instead of dropping the invoke from the FE) lets the splash
//! retain its existing two-beat shape without conditional logic.

/// Splash terminal handshake. Always succeeds; exists so the FE has a
/// command to await before dismissing the splash.
#[tauri::command]
pub async fn finish_splash() -> Result<(), String> {
    Ok(())
}
