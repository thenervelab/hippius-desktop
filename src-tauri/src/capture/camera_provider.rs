//! Which GStreamer device provider finds the cameras on Linux.
//!
//! WebKitGTK opens the camera bubble's camera with the device
//! `GstDeviceMonitor` hands it, and so does the recorder child for camera
//! only on Wayland. Where the `gstreamer1.0-pipewire` plugin is installed its
//! provider hides the V4L2 one, so every camera is opened through
//! `pipewiresrc`. With PipeWire older than [`GOOD_PIPEWIRE`] (Ubuntu 22.04
//! ships 0.3.48) `pipewiresrc` often never delivers a camera picture: it
//! stops with `not-negotiated` or freezes, while the same camera works in a
//! browser, which opens `/dev/video*` itself. The bubble then stayed on its
//! placeholder. WebKitGTK's own PipeWire camera path asks for the same
//! version (its "Please install PipeWire >= 0.3.64").
//!
//! So on such a system the app lowers the PipeWire provider's rank to NONE
//! (`GST_PLUGIN_FEATURE_RANK`) before anything starts: `GstDeviceMonitor`
//! only uses providers of rank MARGINAL or above, the V4L2 provider is no
//! longer hidden, and the web processes and the recorder child (which
//! inherit the environment) open the camera with `v4l2src`, as the browser
//! does. Screen recording is unaffected: it makes `pipewiresrc` by name.
//! A rank the user set for the provider themselves is left alone.

/// The first PipeWire whose `pipewiresrc` WebKitGTK trusts with a camera.
pub const GOOD_PIPEWIRE: (u32, u32, u32) = (0, 3, 64);

/// GStreamer's environment variable for feature ranks, read by `gst_init`.
pub const RANK_VAR: &str = "GST_PLUGIN_FEATURE_RANK";

/// The PipeWire device provider's feature name.
pub const PROVIDER: &str = "pipewiredeviceprovider";

/// PipeWire's version from its library's file name. PipeWire names it
/// `libpipewire-0.3.so.0.<n>.0`, where `n` is `100 * minor + micro` before
/// 1.0 (0.3.48 is `348`) and `1000 * major + 100 * minor + micro` from 1.0
/// on (1.0.5 is `1005`). None for any other file.
#[must_use]
pub fn pipewire_version_from_lib(file_name: &str) -> Option<(u32, u32, u32)> {
    let rest = file_name.strip_prefix("libpipewire-0.3.so.0.")?;
    let (n, tail) = rest.split_once('.')?;
    if tail.is_empty() || !tail.chars().all(|c| c.is_ascii_digit()) || n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let n: u32 = n.parse().ok()?;
    Some(if n >= 1000 {
        (n / 1000, n % 1000 / 100, n % 100)
    } else {
        (0, n / 100, n % 100)
    })
}

/// Whether cameras should be opened through V4L2 instead of PipeWire, for
/// the newest PipeWire library installed (None: no PipeWire at all, so its
/// provider cannot find anything and nothing needs to change).
#[must_use]
pub fn prefers_v4l2(pipewire: Option<(u32, u32, u32)>) -> bool {
    pipewire.is_some_and(|v| v < GOOD_PIPEWIRE)
}

/// The value `GST_PLUGIN_FEATURE_RANK` should have, given its value now:
/// the PipeWire provider at NONE added to whatever is there. None when the
/// user already ranked the provider (their choice stands).
#[must_use]
pub fn rank_override(existing: Option<&str>) -> Option<String> {
    let existing = existing.map(str::trim).filter(|s| !s.is_empty());
    let ours = format!("{PROVIDER}:NONE");
    match existing {
        None => Some(ours),
        Some(value) if value.split(',').any(|entry| entry.split(':').next().map(str::trim) == Some(PROVIDER)) => None,
        Some(value) => Some(format!("{value},{ours}")),
    }
}

/// What [`apply`] decided, logged once logging is up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub pipewire: Option<(u32, u32, u32)>,
    /// The new `GST_PLUGIN_FEATURE_RANK`, when it was changed.
    pub rank: Option<String>,
}

impl Decision {
    /// One line in the app log, so a camera report can be read against it.
    pub fn log(&self) {
        let pipewire = self.pipewire.map_or_else(|| "none".to_string(), |(a, b, c)| format!("{a}.{b}.{c}"));
        if let Some(rank) = &self.rank {
            tracing::info!(pipewire = %pipewire, rank = %rank, "camera: PipeWire is older than 0.3.64, cameras open through V4L2");
        } else {
            tracing::info!(pipewire = %pipewire, "camera: cameras open through GStreamer's default providers");
        }
    }
}

/// Where distributions keep `libpipewire-0.3.so.*`.
#[cfg(target_os = "linux")]
const LIB_DIRS: &[&str] = &[
    "/usr/lib/x86_64-linux-gnu",
    "/usr/lib/aarch64-linux-gnu",
    "/usr/lib64",
    "/usr/lib",
    "/lib/x86_64-linux-gnu",
    "/lib/aarch64-linux-gnu",
];

/// The newest PipeWire library installed.
#[cfg(target_os = "linux")]
fn installed_pipewire() -> Option<(u32, u32, u32)> {
    LIB_DIRS
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flat_map(Iterator::flatten)
        .filter_map(|entry| pipewire_version_from_lib(&entry.file_name().to_string_lossy()))
        .max()
}

/// Lower the PipeWire camera provider where its `pipewiresrc` is too old.
/// Must run in `main` before any thread starts (it sets an environment
/// variable) and before GStreamer or WebKitGTK start.
#[cfg(target_os = "linux")]
pub fn apply() -> Decision {
    let pipewire = installed_pipewire();
    let rank = if prefers_v4l2(pipewire) {
        rank_override(std::env::var(RANK_VAR).ok().as_deref())
    } else {
        None
    };
    if let Some(value) = &rank {
        // SAFETY: called from `main` before the runtime, the logger or any
        // other thread starts, so nothing reads the environment meanwhile.
        unsafe { std::env::set_var(RANK_VAR, value) };
    }
    Decision { pipewire, rank }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipewire_versions_are_read_from_the_library_name() {
        assert_eq!(pipewire_version_from_lib("libpipewire-0.3.so.0.348.0"), Some((0, 3, 48)));
        assert_eq!(pipewire_version_from_lib("libpipewire-0.3.so.0.364.0"), Some((0, 3, 64)));
        assert_eq!(pipewire_version_from_lib("libpipewire-0.3.so.0.1005.0"), Some((1, 0, 5)));
        assert_eq!(pipewire_version_from_lib("libpipewire-0.3.so.0.1402.0"), Some((1, 4, 2)));
        for other in [
            "libpipewire-0.3.so",
            "libpipewire-0.3.so.0",
            "libpipewire-0.3.so.0.348",
            "libpipewire-0.3.so.0.x.0",
            "libpipewire-module-x.so.0.348.0",
            "libgstpipewire.so",
        ] {
            assert_eq!(pipewire_version_from_lib(other), None, "{other}");
        }
    }

    /// Ubuntu 22.04's 0.3.48 opens cameras through V4L2; 0.3.64 and later,
    /// and a machine without PipeWire, keep GStreamer's choice.
    #[test]
    fn only_an_old_pipewire_sends_cameras_to_v4l2() {
        assert!(prefers_v4l2(Some((0, 3, 48))));
        assert!(prefers_v4l2(Some((0, 3, 63))));
        assert!(!prefers_v4l2(Some((0, 3, 64))));
        assert!(!prefers_v4l2(Some((1, 0, 5))));
        assert!(!prefers_v4l2(None));
    }

    #[test]
    fn the_rank_is_added_to_what_is_there_and_never_overrides_the_user() {
        assert_eq!(rank_override(None).as_deref(), Some("pipewiredeviceprovider:NONE"));
        assert_eq!(rank_override(Some("  ")).as_deref(), Some("pipewiredeviceprovider:NONE"));
        assert_eq!(
            rank_override(Some("vah264enc:PRIMARY")).as_deref(),
            Some("vah264enc:PRIMARY,pipewiredeviceprovider:NONE")
        );
        assert_eq!(rank_override(Some("pipewiredeviceprovider:PRIMARY")), None);
        assert_eq!(rank_override(Some("x:1, pipewiredeviceprovider:MAX")), None);
    }
}
