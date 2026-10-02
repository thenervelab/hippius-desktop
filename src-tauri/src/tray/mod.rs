//! System-tray popover panel.
//!
//! Replaces the legacy native tray menu with a borderless webview window
//! anchored to the tray icon. [`geometry`] holds the OS-agnostic placement math
//! (which edge the panel drops from, on-screen clamping); [`panel`] owns the
//! window lifecycle and the `toggle_tray_panel` / `hide_tray_panel` IPC
//! commands. The data the panel renders (credits, account, uploads) is fetched
//! by the frontend through the existing IPC commands — see `utils::tray_menu`.
//! [`status_menu`] keeps the right-click menu off the macOS status item so
//! the left click reaches the app at all.
pub mod geometry;
pub mod panel;
pub mod status_menu;
