//! `--list-microphones` on Linux: the inputs PipeWire or PulseAudio offer,
//! from `GstDeviceMonitor`, as the bar's microphone menu shows them
//! (`linux_plan::microphones`: monitors dropped, default first). The id is
//! the source name `pulsesrc device=` opens, so the recorder opens exactly
//! the device chosen, with no name matching.

use gstreamer as gst;
use gstreamer::prelude::*;

use super::super::linux_plan::{RawAudioSource, microphones};
use crate::capture::recording::MediaDevice;

/// The microphones, default first; empty when GStreamer cannot list them.
#[must_use]
pub fn list_microphones() -> Vec<MediaDevice> {
    if super::init().is_err() {
        return Vec::new();
    }
    let monitor = gst::DeviceMonitor::new();
    let _ = monitor.add_filter(Some("Audio/Source"), None);
    if monitor.start().is_err() {
        return Vec::new();
    }
    let raw: Vec<RawAudioSource> = monitor.devices().into_iter().filter_map(|d| raw_source(&d)).collect();
    monitor.stop();
    microphones(raw)
}

/// A device as the list needs it. PipeWire's provider names the node in
/// `node.name`; PulseAudio's names it only on the element it makes, as
/// `pulsesrc`'s `device`.
fn raw_source(device: &gst::Device) -> Option<RawAudioSource> {
    let props = device.properties();
    let text = |key: &str| props.as_ref().and_then(|p| p.get::<String>(key).ok());
    let id = text("node.name").or_else(|| {
        let element = device.create_element(None).ok()?;
        element
            .has_property("device")
            .then(|| element.property::<Option<String>>("device"))
            .flatten()
    })?;
    Some(RawAudioSource {
        id,
        display_name: device.display_name().to_string(),
        device_class: text("device.class"),
        is_default: props.as_ref().and_then(|p| p.get::<bool>("is-default").ok()).unwrap_or(false),
    })
}
