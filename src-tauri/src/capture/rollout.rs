//! Which capture features each platform ships on each release lane.
//!
//! `SCREEN_CAPTURE_ENABLED` in the frontend stays the one switch for the whole
//! feature. Underneath it, a platform's readiness is Rust's: a feature below
//! its lane's floor reports exactly what it reports when unsupported
//! (`capture_support.supported == false` for screenshots, `UnsupportedPlatform`
//! for recording), so no lane ever shows a half-ready platform and the
//! frontend needs no new flag. Moving a platform on (staging, then beta, then
//! production) is a one-line change to [`floor`], made once that platform's
//! manual checklist passes (`docs/plans/2026-10-01-capture-windows-linux.md`,
//! "Rollout gating").
//!
//! Debug builds count as staging, so `pnpm tauri dev` shows everything built.
//! Pinned by the table tests below and by `tests/release_lane_pins.rs`
//! (production enables only rows marked production, and Windows recording
//! reaches production only with a signed installer).

use crate::release_channel::{self, ReleaseChannel};

/// Where the app runs, as far as capture is concerned. Linux is two
/// platforms: X11 and Wayland differ in everything capture does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Platform {
    MacOs,
    Windows,
    LinuxX11,
    LinuxWayland,
}

impl Platform {
    pub const ALL: [Self; 4] = [Self::MacOs, Self::Windows, Self::LinuxX11, Self::LinuxWayland];
}

/// A capture feature that rolls out on its own per platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Feature {
    Screenshots,
    Recording,
    /// Wayland's GlobalShortcuts portal (the plugin covers the others).
    ShortcutPortal,
}

impl Feature {
    pub const ALL: [Self; 3] = [Self::Screenshots, Self::Recording, Self::ShortcutPortal];
}

/// The lowest lane that ships `feature` on `platform`: `Staging` = staging
/// only, `Beta` = beta and staging, `Production` = everywhere. `None` = the
/// feature does not exist on that platform.
///
/// Exhaustive on purpose: a new platform or feature does not compile until
/// every row is decided.
#[must_use]
// One arm per platform on purpose: each row moves on by itself.
#[allow(clippy::match_same_arms)]
pub const fn floor(platform: Platform, feature: Feature) -> Option<ReleaseChannel> {
    use Feature::{Recording, Screenshots, ShortcutPortal};
    use Platform::{LinuxWayland, LinuxX11, MacOs, Windows};
    match (platform, feature) {
        // macOS ships wherever the frontend switch does.
        (MacOs, Screenshots | Recording) => Some(ReleaseChannel::Production),
        // Windows screenshots: beta once Phase 1's hardware checklist passes.
        // Windows recording: production only once the installer is signed.
        (Windows, Screenshots | Recording) => Some(ReleaseChannel::Staging),
        (LinuxX11 | LinuxWayland, Screenshots | Recording) => Some(ReleaseChannel::Staging),
        (LinuxWayland, ShortcutPortal) => Some(ReleaseChannel::Staging),
        (MacOs | Windows | LinuxX11, ShortcutPortal) => None,
    }
}

/// How far a lane reaches: staging sees everything, production the least.
const fn reach(channel: ReleaseChannel) -> u8 {
    match channel {
        ReleaseChannel::Staging => 0,
        ReleaseChannel::Beta => 1,
        ReleaseChannel::Production => 2,
    }
}

/// Whether a build of `channel` offers `feature` on `platform`.
#[must_use]
pub const fn enabled(channel: ReleaseChannel, platform: Platform, feature: Feature) -> bool {
    match floor(platform, feature) {
        Some(lowest) => reach(channel) <= reach(lowest),
        None => false,
    }
}

/// The lane this build answers for: its own, except that a debug build is
/// staging (a local `cargo build` reports production, which would hide every
/// platform still on staging from the developers building it).
#[must_use]
pub const fn effective_channel(built: ReleaseChannel, debug_build: bool) -> ReleaseChannel {
    if debug_build { ReleaseChannel::Staging } else { built }
}

/// Which Linux this is, from the session's own variables: Wayland when the
/// session says so or a Wayland display is set, X11 otherwise.
#[must_use]
pub fn linux_platform(xdg_session_type: Option<&str>, wayland_display: Option<&str>) -> Platform {
    let wayland = xdg_session_type.is_some_and(|t| t.trim().eq_ignore_ascii_case("wayland")) || wayland_display.is_some_and(|d| !d.trim().is_empty());
    if wayland { Platform::LinuxWayland } else { Platform::LinuxX11 }
}

/// The platform this process runs on.
#[must_use]
pub fn current_platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::MacOs
    } else if cfg!(windows) {
        Platform::Windows
    } else {
        let session = std::env::var("XDG_SESSION_TYPE").ok();
        let display = std::env::var("WAYLAND_DISPLAY").ok();
        linux_platform(session.as_deref(), display.as_deref())
    }
}

/// Whether this build, here, offers `feature`.
#[must_use]
pub fn allows(feature: Feature) -> bool {
    let channel = effective_channel(release_channel::current(), cfg!(debug_assertions));
    enabled(channel, current_platform(), feature)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LANES: [ReleaseChannel; 3] = [ReleaseChannel::Staging, ReleaseChannel::Beta, ReleaseChannel::Production];

    /// Every platform has a decision for every feature it has, and the
    /// features it lacks are off on every lane.
    #[test]
    fn every_platform_and_feature_has_a_row() {
        for platform in Platform::ALL {
            for feature in [Feature::Screenshots, Feature::Recording] {
                assert!(floor(platform, feature).is_some(), "{platform:?} has no {feature:?} row");
            }
            if floor(platform, Feature::ShortcutPortal).is_none() {
                for lane in LANES {
                    assert!(!enabled(lane, platform, Feature::ShortcutPortal));
                }
            }
        }
        assert!(floor(Platform::LinuxWayland, Feature::ShortcutPortal).is_some());
    }

    /// A lane sees what its floor and every lane above it sees: staging is a
    /// superset of beta, beta of production.
    #[test]
    fn staging_sees_everything_beta_sees_and_beta_everything_production_sees() {
        for platform in Platform::ALL {
            for feature in Feature::ALL {
                let on = |lane| enabled(lane, platform, feature);
                assert!(!on(ReleaseChannel::Production) || on(ReleaseChannel::Beta), "{platform:?} {feature:?}");
                assert!(!on(ReleaseChannel::Beta) || on(ReleaseChannel::Staging), "{platform:?} {feature:?}");
            }
        }
    }

    /// Today's lanes: macOS everywhere the frontend switch is; Windows and
    /// Linux on staging only.
    #[test]
    fn today_only_macos_leaves_staging() {
        for feature in [Feature::Screenshots, Feature::Recording] {
            assert!(enabled(ReleaseChannel::Production, Platform::MacOs, feature));
            for platform in [Platform::Windows, Platform::LinuxX11, Platform::LinuxWayland] {
                assert!(enabled(ReleaseChannel::Staging, platform, feature), "{platform:?} {feature:?}");
                assert!(!enabled(ReleaseChannel::Beta, platform, feature), "{platform:?} {feature:?}");
                assert!(!enabled(ReleaseChannel::Production, platform, feature), "{platform:?} {feature:?}");
            }
        }
    }

    #[test]
    fn a_debug_build_counts_as_staging() {
        assert_eq!(effective_channel(ReleaseChannel::Production, true), ReleaseChannel::Staging);
        assert_eq!(effective_channel(ReleaseChannel::Beta, false), ReleaseChannel::Beta);
        assert_eq!(effective_channel(ReleaseChannel::Production, false), ReleaseChannel::Production);
    }

    #[test]
    fn linux_is_wayland_when_the_session_says_so() {
        assert_eq!(linux_platform(Some("wayland"), None), Platform::LinuxWayland);
        assert_eq!(linux_platform(Some("x11"), Some("wayland-0")), Platform::LinuxWayland);
        assert_eq!(linux_platform(Some("x11"), None), Platform::LinuxX11);
        assert_eq!(linux_platform(Some("tty"), Some(" ")), Platform::LinuxX11);
        assert_eq!(linux_platform(None, None), Platform::LinuxX11);
    }
}
