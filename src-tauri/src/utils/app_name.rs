//! The name the app shows people: "Hippius Drive".
//!
//! The DISPLAY name and the BUNDLE name are deliberately different.
//! `productName` in `tauri.conf.json` stays "Hippius": Tauri derives the
//! macOS bundle folder (`Hippius.app`), the binary, the Windows install
//! folder, uninstall entry and MSI upgrade code, the Linux package and
//! `.desktop` file, and every release asset name from it. Renaming it would
//! leave existing installs beside a second copy instead of updating them, and
//! break the release scripts that look for `Hippius.app`. So only what people
//! read changes: the window title, the tray, the macOS menu bar
//! (`CFBundleName` in `Info.plist`) and the app menu below.
//!
//! Finder, Launchpad, Spotlight and the Dock name an app by its folder
//! (`Hippius.app`) unless it has a localized display name, so on macOS the
//! name comes from `en.lproj/InfoPlist.strings` (`LSHasLocalizedDisplayName`).
//! macOS only applies it when the unlocalized `CFBundleDisplayName` equals the
//! folder name, which is why that one Info.plist value says "Hippius".
//!
//! Pinned against `tauri.conf.json`, `Info.plist` and `InfoPlist.strings` by
//! this module's tests.

/// What the app calls itself wherever it names the app.
pub const APP_DISPLAY_NAME: &str = "Hippius Drive";

/// The macOS app menu (the bold one beside the Apple menu), with the app's
/// display name in About, Hide and Quit.
///
/// Tauri's default menu takes those from `productName`, which stays "Hippius"
/// (see the module docs), so this swaps in an app submenu that names the app
/// "Hippius Drive" and keeps every other default menu (Edit, View, Window,
/// Help) exactly as Tauri builds it.
#[cfg(target_os = "macos")]
pub fn macos_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};

    let menu = Menu::default(app)?;
    let pkg = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(APP_DISPLAY_NAME.to_string()),
        version: Some(pkg.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        APP_DISPLAY_NAME,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&format!("About {APP_DISPLAY_NAME}")), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&format!("Hide {APP_DISPLAY_NAME}")))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&format!("Quit {APP_DISPLAY_NAME}")))?,
        ],
    )?;
    // On macOS the default menu's first entry is the app submenu.
    menu.remove_at(0)?;
    menu.prepend(&app_menu)?;
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::APP_DISPLAY_NAME;

    fn conf() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tauri.conf.json")).expect("tauri.conf.json parses")
    }

    /// The `<string>` right after `<key>{key}</key>` in Info.plist.
    fn plist_string(key: &str) -> Option<String> {
        let plist = include_str!("../../Info.plist");
        let after = plist.split(&format!("<key>{key}</key>")).nth(1)?;
        let start = after.find("<string>")? + "<string>".len();
        let end = after.find("</string>")?;
        Some(after[start..end].trim().to_string())
    }

    /// `productName` names the bundle folder, the Windows install and the
    /// Linux package. A rename there ships a second app beside every
    /// existing install instead of updating it, so it must not ride along
    /// with a display-name change.
    #[test]
    fn the_bundle_name_stays_hippius_so_installs_update_in_place() {
        assert_eq!(conf()["productName"].as_str(), Some("Hippius"));
        assert_eq!(plist_string("CFBundleExecutable").as_deref(), Some("Hippius"));
        assert_eq!(plist_string("CFBundleIdentifier").as_deref(), Some("hippius.com"));
        assert_eq!(conf()["identifier"].as_str(), Some("hippius.com"));
    }

    /// The value of `"{key}" = "...";` in the bundled InfoPlist.strings.
    fn strings_value(key: &str) -> Option<String> {
        let strings = include_str!("../../locales/en.lproj/InfoPlist.strings");
        let after = strings.split(&format!("\"{key}\" = \"")).nth(1)?;
        Some(after[..after.find("\";")?].to_string())
    }

    /// The macOS menu bar shows `CFBundleName`; it must say what the window
    /// title and the app menu say.
    #[test]
    fn the_menu_bar_name_is_the_display_name() {
        assert_eq!(plist_string("CFBundleName").as_deref(), Some(APP_DISPLAY_NAME));
        assert_eq!(strings_value("CFBundleName").as_deref(), Some(APP_DISPLAY_NAME));
        // macOS truncates a CFBundleName longer than 15 characters.
        assert!(APP_DISPLAY_NAME.chars().count() <= 15);
    }

    /// Finder, Launchpad, Spotlight and the Dock show the localized
    /// `CFBundleDisplayName`, and only when the bundle opts in AND the
    /// unlocalized value equals the folder name (`productName`). Setting the
    /// unlocalized value to "Hippius Drive" makes them show "Hippius" again.
    #[test]
    fn finder_shows_the_display_name_through_a_localized_name() {
        assert_eq!(plist_string("CFBundleDisplayName").as_deref(), conf()["productName"].as_str());
        let plist = include_str!("../../Info.plist");
        let after = plist
            .split("<key>LSHasLocalizedDisplayName</key>")
            .nth(1)
            .expect("LSHasLocalizedDisplayName is declared");
        assert!(after.trim_start().starts_with("<true/>"), "LSHasLocalizedDisplayName must be true");
        assert_eq!(strings_value("CFBundleDisplayName").as_deref(), Some(APP_DISPLAY_NAME));
    }

    /// The strings file only counts if it lands in the bundle, in the
    /// development region's folder, which every other language falls back to.
    #[test]
    fn the_localized_name_is_bundled_for_the_development_region() {
        assert_eq!(plist_string("CFBundleDevelopmentRegion").as_deref(), Some("en"));
        assert_eq!(
            conf()["bundle"]["macOS"]["files"]["Resources/en.lproj/InfoPlist.strings"].as_str(),
            Some("locales/en.lproj/InfoPlist.strings")
        );
    }
}
