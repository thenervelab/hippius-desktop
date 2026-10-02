//! `--probe` on Linux: whether this machine can record, asked once per
//! launch by the app (`recording::linux`). GStreamer's registry says which
//! encoders and elements are installed; on Wayland the ScreenCast portal is
//! asked whether it exists (no dialog).

use super::super::linux_plan::Probe;
use crate::capture::rollout::{Platform, current_platform};

#[must_use]
pub fn probe() -> Probe {
    let wayland = current_platform() == Platform::LinuxWayland;
    if super::init().is_err() {
        return Probe {
            session: Some(if wayland { "wayland" } else { "x11" }.into()),
            ..Probe::default()
        };
    }
    let mut probe = Probe::from_registry(wayland, super::installed);
    if wayland {
        probe.screencast_portal = Some(super::portal::screencast_available());
    }
    probe
}
