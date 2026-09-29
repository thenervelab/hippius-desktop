//! The system-wide shortcut that opens the capture bar from any app.
//!
//! One shortcut, default Cmd+Shift+2 on macOS and Ctrl+Shift+2 on Windows:
//! next to macOS's own Cmd+Shift+3/4/5/6 and unused by the system. The user
//! can change it or turn it off in Settings. Pressing it emits
//! [`SHORTCUT_EVENT`]; the main window's `CaptureHost` starts the capture the
//! same way the Capture button does, so a missing drive or permission is
//! answered by the same dialogs.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::{AppError, Result};

pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+2";
pub const SHORTCUT_EVENT: &str = "capture_shortcut_pressed";

const KEY: &str = "capture_shortcut_v1";
/// Stored for "turned off", so it is told apart from "never set" (the default).
const OFF: &str = "off";

/// macOS keeps these for its own screenshot tools; registering one would
/// either fail or take the system's shortcut away.
#[cfg(any(target_os = "macos", windows))]
const MACOS_RESERVED: [&str; 4] = ["Command+Shift+3", "Command+Shift+4", "Command+Shift+5", "Command+Shift+6"];

/// What Settings shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSetting {
    /// The active shortcut, or `None` when turned off.
    pub accelerator: Option<String>,
    pub default_accelerator: String,
}

/// The saved shortcut: the default when never set, `None` when turned off.
pub async fn load(pool: &SqlitePool) -> Result<Option<String>> {
    let raw = crate::utils::preferences::get_user_preference_internal(pool, KEY).await?;
    Ok(stored_to_active(raw.as_deref()))
}

fn stored_to_active(raw: Option<&str>) -> Option<String> {
    match raw {
        None | Some("") => Some(DEFAULT_SHORTCUT.to_string()),
        Some(OFF) => None,
        Some(accel) => Some(accel.to_string()),
    }
}

pub async fn save(pool: &SqlitePool, accelerator: Option<&str>) -> Result<()> {
    crate::utils::preferences::save_user_preference_internal(pool, KEY, accelerator.unwrap_or(OFF)).await
}

/// Parse `accelerator` and refuse one that would misbehave as a system-wide
/// shortcut: no modifier (it would swallow a plain key in every app) or one of
/// macOS's own capture shortcuts.
///
/// # Errors
///
/// [`AppError::Validation`] with the sentence Settings shows.
#[cfg(any(target_os = "macos", windows))]
pub fn validate(accelerator: &str) -> Result<tauri_plugin_global_shortcut::Shortcut> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{Modifiers, Shortcut};

    let shortcut = Shortcut::from_str(accelerator.trim())
        .map_err(|_| AppError::Validation("That isn't a shortcut Hippius can use. Try a modifier with a letter or number.".into()))?;
    let needs = Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT;
    if !shortcut.mods.intersects(needs) {
        return Err(AppError::Validation(
            "Use Command, Control or Option (Alt) in the shortcut, so it doesn't take over a key in every app.".into(),
        ));
    }
    if cfg!(target_os = "macos")
        && MACOS_RESERVED
            .iter()
            .filter_map(|r| Shortcut::from_str(r).ok())
            .any(|r| r.mods == shortcut.mods && r.key == shortcut.key)
    {
        return Err(AppError::Validation(
            "macOS uses that shortcut for its own screenshots. Choose another.".into(),
        ));
    }
    Ok(shortcut)
}

/// Make `accelerator` the one registered shortcut (or none).
///
/// Every global shortcut this app registers is the capture one, so the old
/// one is cleared with `unregister_all` rather than tracked.
///
/// # Errors
///
/// [`AppError::Validation`] when the shortcut is invalid or another app holds it.
#[cfg(any(target_os = "macos", windows))]
pub fn apply(app: &tauri::AppHandle, accelerator: Option<&str>) -> Result<()> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let Some(accelerator) = accelerator else {
        return Ok(());
    };
    let shortcut = validate(accelerator)?;
    gs.register(shortcut)
        .map_err(|_| AppError::Validation("Another app is already using that shortcut. Choose another.".into()))
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn apply(_app: &tauri::AppHandle, _accelerator: Option<&str>) -> Result<()> {
    Ok(())
}

/// The plugin, with the one handler every capture shortcut shares.
#[cfg(any(target_os = "macos", windows))]
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::ShortcutState;

    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app.emit(SHORTCUT_EVENT, ());
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_set_is_the_default_and_off_is_off() {
        assert_eq!(stored_to_active(None).as_deref(), Some(DEFAULT_SHORTCUT));
        assert_eq!(stored_to_active(Some("")).as_deref(), Some(DEFAULT_SHORTCUT));
        assert_eq!(stored_to_active(Some("off")), None);
        assert_eq!(stored_to_active(Some("Alt+Shift+C")).as_deref(), Some("Alt+Shift+C"));
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn the_default_is_a_valid_shortcut() {
        assert!(validate(DEFAULT_SHORTCUT).is_ok());
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn a_shortcut_needs_a_real_modifier() {
        assert!(matches!(validate("Shift+2"), Err(AppError::Validation(_))));
        assert!(matches!(validate("F"), Err(AppError::Validation(_))));
        assert!(matches!(validate("not a shortcut"), Err(AppError::Validation(_))));
        assert!(validate("Control+Alt+C").is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_its_own_screenshot_shortcuts() {
        for reserved in ["Command+Shift+3", "Cmd+Shift+4", "CommandOrControl+Shift+5", "Super+Shift+6"] {
            assert!(matches!(validate(reserved), Err(AppError::Validation(_))), "{reserved}");
        }
        assert!(validate("Command+Shift+7").is_ok());
    }

    #[tokio::test]
    async fn turning_it_off_is_remembered() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::utils::schema::ensure_table_schema(&pool).await.unwrap();
        assert_eq!(load(&pool).await.unwrap().as_deref(), Some(DEFAULT_SHORTCUT));
        save(&pool, None).await.unwrap();
        assert_eq!(load(&pool).await.unwrap(), None);
        save(&pool, Some("Control+Alt+C")).await.unwrap();
        assert_eq!(load(&pool).await.unwrap().as_deref(), Some("Control+Alt+C"));
    }
}
