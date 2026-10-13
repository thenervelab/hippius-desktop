//! The capture shortcut where Wayland has no GlobalShortcuts portal: a
//! keyboard shortcut in the desktop's own settings that runs
//! `hippius --capture`.
//!
//! A second `hippius --capture` reaches the running app through the
//! single-instance handler (`main.rs`, `cli::argv_requests_capture`), which
//! does what a press of the shortcut does (`commands::on_shortcut`) and
//! nothing else: the main window is not brought forward. Settings shows the
//! command to bind ([`command`]) and, on GNOME, adds the shortcut for the
//! user: a custom keybinding under
//! `org.gnome.settings-daemon.plugins.media-keys`, the same entry GNOME's
//! Settings > Keyboard > Custom Shortcuts writes, at Hippius's own path
//! ([`GNOME_PATH`]) so it is found again and never duplicated.
//!
//! The text handling is pure and tested on every OS; running `gsettings` is
//! Linux only.

/// The flag the desktop's shortcut passes.
pub const CAPTURE_FLAG: &str = "--capture";

/// Hippius's own custom keybinding, beside GNOME's `custom0`, `custom1`...
pub const GNOME_PATH: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/hippius-capture/";
/// The schema holding the list of custom keybindings.
pub const GNOME_LIST_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys";
/// The relocatable schema of one custom keybinding.
pub const GNOME_ENTRY_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
/// The name GNOME's keyboard settings show for it.
pub const GNOME_NAME: &str = "Hippius capture";

/// Settings' line where the desktop lets no app set a shortcut.
pub const DESKTOP_SETTINGS_LINE: &str =
    "Your desktop doesn't let apps set a shortcut themselves. Add one in your desktop's keyboard settings that runs this command:";

/// The flag a desktop shortcut for the Record shortcut passes: the capture
/// bar on Record, or stop the recording running.
pub const RECORD_FLAG: &str = "--record";

/// Settings' line for the Record shortcut on Wayland. The portal session
/// binds only the screenshot shortcut, so even where the desktop has the
/// portal, this one is added in the desktop's own keyboard settings.
pub const RECORD_DESKTOP_SETTINGS_LINE: &str =
    "Hippius can't set this shortcut on your desktop. Add one in your desktop's keyboard settings that runs this command:";

/// The command line a desktop shortcut runs: this executable, quoted for a
/// shell when its path needs it, and the flag.
#[must_use]
pub fn command_for(exe: &str) -> String {
    command_with_flag(exe, CAPTURE_FLAG)
}

/// [`command_for`] with another flag ([`RECORD_FLAG`]).
#[must_use]
pub fn command_with_flag(exe: &str, flag: &str) -> String {
    let safe = !exe.is_empty() && exe.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '+'));
    if safe {
        format!("{exe} {flag}")
    } else {
        format!("'{}' {flag}", exe.replace('\'', r"'\''"))
    }
}

fn this_exe() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_else(|| "hippius".to_string())
}

/// This app's command, worked out once.
#[must_use]
pub fn command() -> &'static str {
    static COMMAND: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    COMMAND.get_or_init(|| command_for(&this_exe()))
}

/// This app's command for the Record shortcut, worked out once.
#[must_use]
pub fn record_command() -> &'static str {
    static COMMAND: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    COMMAND.get_or_init(|| command_with_flag(&this_exe(), RECORD_FLAG))
}

/// Whether this desktop is GNOME (Ubuntu says `ubuntu:GNOME`), where
/// Hippius can add the shortcut itself.
#[must_use]
pub fn is_gnome(xdg_current_desktop: Option<&str>) -> bool {
    xdg_current_desktop.is_some_and(|d| d.split(':').any(|part| part.trim().eq_ignore_ascii_case("gnome")))
}

/// A Tauri accelerator in GNOME's binding syntax ("<Control><Shift>2"), or
/// `None` when it has no key or a key not worth guessing.
#[must_use]
pub fn gnome_binding(accelerator: &str) -> Option<String> {
    let mut mods: Vec<&str> = Vec::new();
    let mut key: Option<String> = None;
    for part in accelerator.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        let modifier = match part.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "commandorctrl" | "cmdorcontrol" | "control" | "ctrl" => Some("<Control>"),
            "shift" => Some("<Shift>"),
            "alt" | "option" => Some("<Alt>"),
            "super" | "command" | "cmd" | "meta" => Some("<Super>"),
            _ => None,
        };
        if let Some(m) = modifier {
            if !mods.contains(&m) {
                mods.push(m);
            }
        } else if key.is_some() {
            return None;
        } else {
            // The XDG trigger's key names are xkb keysyms, which GNOME uses too.
            let trigger = super::shortcut_portal::portal_trigger(&format!("Control+{part}"))?;
            key = Some(trigger.trim_start_matches("CTRL+").to_string());
        }
    }
    let key = key?;
    let ordered: String = ["<Control>", "<Alt>", "<Shift>", "<Super>"]
        .into_iter()
        .filter(|m| mods.contains(m))
        .collect();
    (!ordered.is_empty()).then(|| format!("{ordered}{key}"))
}

/// The paths in `gsettings get ... custom-keybindings`' answer: `@as []`
/// for none, else a list like `['/a/', '/b/']`.
#[must_use]
pub fn parse_path_list(answer: &str) -> Vec<String> {
    let text = answer.trim().trim_start_matches("@as").trim();
    let Some(inner) = text.strip_prefix('[').and_then(|t| t.strip_suffix(']')) else {
        return Vec::new();
    };
    inner
        .split(',')
        .map(|item| item.trim().trim_matches(['\'', '"']).to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// A path list in GVariant text, for `gsettings set`.
#[must_use]
pub fn format_path_list(paths: &[String]) -> String {
    let items: Vec<String> = paths.iter().map(|p| format!("'{}'", p.replace('\'', ""))).collect();
    format!("[{}]", items.join(", "))
}

/// `paths` with Hippius's own entry, added once.
#[must_use]
pub fn with_hippius(mut paths: Vec<String>) -> Vec<String> {
    if !paths.iter().any(|p| p == GNOME_PATH) {
        paths.push(GNOME_PATH.to_string());
    }
    paths
}

/// A string in GVariant text: single-quoted, `'` and `\` escaped.
#[must_use]
pub fn gvariant_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', r"\\").replace('\'', r"\'"))
}

/// Whether Hippius can add the shortcut on this desktop itself (GNOME with
/// `gsettings`), and whether it already has. `None`: it cannot.
#[cfg(target_os = "linux")]
#[must_use]
pub fn gnome_shortcut_added() -> Option<bool> {
    if !is_gnome(std::env::var("XDG_CURRENT_DESKTOP").ok().as_deref()) {
        return None;
    }
    let answer = gsettings(&["get", GNOME_LIST_SCHEMA, "custom-keybindings"]).ok()?;
    Some(parse_path_list(&answer).iter().any(|p| p == GNOME_PATH))
}

/// Add (or update) Hippius's custom keybinding on GNOME: `accelerator`
/// runs [`command`].
///
/// # Errors
///
/// [`crate::error::AppError::Validation`] when this is not GNOME, the
/// accelerator cannot be written in GNOME's syntax, or `gsettings` fails.
#[cfg(target_os = "linux")]
pub fn add_gnome_shortcut(accelerator: &str) -> crate::error::Result<()> {
    use crate::error::AppError;
    const FAILED: &str = "Hippius couldn't add the shortcut to your desktop's settings. Add it yourself with the command shown.";

    if !is_gnome(std::env::var("XDG_CURRENT_DESKTOP").ok().as_deref()) {
        return Err(AppError::Validation(FAILED.into()));
    }
    let binding = gnome_binding(accelerator).ok_or_else(|| AppError::Validation(FAILED.into()))?;
    let entry = format!("{GNOME_ENTRY_SCHEMA}:{GNOME_PATH}");
    let fail = |e: String| {
        tracing::warn!(error = %e, "gsettings did not take the capture shortcut");
        AppError::Validation(FAILED.into())
    };
    // The entry first, then the list: GNOME starts listening to an entry
    // once it is in the list, and finds it complete.
    gsettings(&["set", &entry, "name", &gvariant_string(GNOME_NAME)]).map_err(fail)?;
    gsettings(&["set", &entry, "command", &gvariant_string(command())]).map_err(fail)?;
    gsettings(&["set", &entry, "binding", &gvariant_string(&binding)]).map_err(fail)?;
    let current = gsettings(&["get", GNOME_LIST_SCHEMA, "custom-keybindings"]).map_err(fail)?;
    let list = with_hippius(parse_path_list(&current));
    gsettings(&["set", GNOME_LIST_SCHEMA, "custom-keybindings", &format_path_list(&list)]).map_err(fail)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn gsettings(args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("gsettings").args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_runs_this_app_with_the_flag() {
        assert_eq!(command_for("/usr/bin/hippius"), "/usr/bin/hippius --capture");
        assert_eq!(command_for("/opt/My Apps/Hippius"), "'/opt/My Apps/Hippius' --capture");
        assert_eq!(command_for("/tmp/it's"), r"'/tmp/it'\''s' --capture");
        assert!(command().ends_with(" --capture"));
    }

    /// The Record shortcut's command is the same app with its own flag,
    /// quoted the same way.
    #[test]
    fn the_record_command_runs_this_app_with_the_record_flag() {
        assert_eq!(command_with_flag("/usr/bin/hippius", RECORD_FLAG), "/usr/bin/hippius --record");
        assert_eq!(command_with_flag("/opt/My Apps/Hippius", RECORD_FLAG), "'/opt/My Apps/Hippius' --record");
        assert!(record_command().ends_with(" --record"));
        assert_ne!(RECORD_FLAG, CAPTURE_FLAG);
        assert!(!RECORD_DESKTOP_SETTINGS_LINE.contains('\u{2014}'));
    }

    #[test]
    fn gnome_is_found_in_ubuntus_desktop_name_too() {
        assert!(is_gnome(Some("GNOME")));
        assert!(is_gnome(Some("ubuntu:GNOME")));
        assert!(is_gnome(Some("gnome")));
        assert!(!is_gnome(Some("KDE")));
        assert!(!is_gnome(Some("X-Cinnamon")));
        assert!(!is_gnome(None));
    }

    #[test]
    fn an_accelerator_becomes_a_gnome_binding() {
        assert_eq!(gnome_binding("CommandOrControl+Shift+2").as_deref(), Some("<Control><Shift>2"));
        assert_eq!(gnome_binding("Super+Alt+R").as_deref(), Some("<Alt><Super>r"));
        assert_eq!(gnome_binding("Control+F9").as_deref(), Some("<Control>F9"));
        assert_eq!(gnome_binding("Shift"), None);
        assert_eq!(gnome_binding("2"), None, "a key alone is never bound");
        assert_eq!(gnome_binding("Control+BracketLeft"), None);
    }

    /// GNOME's list round-trips, keeps the user's own shortcuts, and gets
    /// Hippius's entry once however often it is added.
    #[test]
    fn the_custom_list_keeps_the_users_shortcuts_and_adds_ours_once() {
        assert!(parse_path_list("@as []\n").is_empty());
        let mine = "['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/']\n";
        let parsed = parse_path_list(mine);
        assert_eq!(parsed, ["/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/"]);
        let added = with_hippius(parsed);
        assert_eq!(added.len(), 2);
        assert_eq!(with_hippius(added.clone()), added);
        assert_eq!(
            format_path_list(&added),
            format!("['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/', '{GNOME_PATH}']")
        );
        assert_eq!(parse_path_list(&format_path_list(&added)), added);
    }

    #[test]
    fn values_are_quoted_for_gsettings() {
        assert_eq!(gvariant_string("Hippius capture"), "'Hippius capture'");
        assert_eq!(gvariant_string("'/opt/x' --capture"), r"'\'/opt/x\' --capture'");
    }

    #[test]
    fn the_settings_line_has_no_em_dash() {
        assert!(!DESKTOP_SETTINGS_LINE.contains('\u{2014}'));
    }
}
