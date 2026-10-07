//! The name the Linux desktop knows the app by.
//!
//! GNOME Shell (and the Alt+Tab switcher, the dash, the overview) ties a
//! window to an app by the window's app id (Wayland) or `WM_CLASS` (X11),
//! matched against the installed `.desktop` file: Tauri's deb and rpm write
//! `<productName>.desktop` with `StartupWMClass=<main binary>`, both
//! "Hippius". GTK takes the app id from the program name, which nothing set
//! (tao calls `gtk_init` without `argv`), so the windows were matched to no
//! app. A window with no app is shown as an app of its own, named by its
//! title: while the main window is hidden for a recording, the pill
//! ("Hippius recording") and the camera bubble each showed up as a separate
//! app in Alt+Tab. With the name set, every Hippius window belongs to the one
//! Hippius app. (Wayland gives an app no way to keep a window out of the
//! overview itself; `skip_taskbar` covers X11.)

/// The app id and program name: the main binary's name, which is what
/// `StartupWMClass` holds and the `.desktop` file is named after. Pinned
/// against `tauri.conf.json` by this module's test.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const LINUX_APP_ID: &str = env!("CARGO_PKG_NAME");

/// Set the program name GTK makes the app id from. Must run before GTK
/// starts (before the Tauri builder runs).
#[cfg(target_os = "linux")]
pub fn apply() {
    gtk::glib::set_prgname(Some(LINUX_APP_ID));
    gtk::glib::set_application_name(LINUX_APP_ID);
}

#[cfg(not(target_os = "linux"))]
pub const fn apply() {}

#[cfg(test)]
mod tests {
    use super::LINUX_APP_ID;

    /// The app id must be what the bundler names the `.desktop` file after
    /// (`productName`) and puts in `StartupWMClass` (the main binary, the
    /// Cargo package unless `mainBinaryName` says otherwise), or GNOME
    /// matches the windows to no app again.
    #[test]
    fn the_app_id_matches_the_installed_desktop_file() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).expect("tauri.conf.json parses");
        assert_eq!(conf["productName"].as_str(), Some(LINUX_APP_ID));
        let binary = conf["mainBinaryName"].as_str().unwrap_or(LINUX_APP_ID);
        assert_eq!(binary, LINUX_APP_ID);
        assert!(!LINUX_APP_ID.contains(' '), "a quoted Exec would not match the app id");
    }
}
