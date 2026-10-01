//! `--list-microphones` on Linux: the inputs PipeWire or PulseAudio offer,
//! from `GstDeviceMonitor`, as the bar's microphone menu shows them
//! (`linux_plan::microphones`: monitors dropped, default first). The id is
//! the source name `pulsesrc device=` opens, so the recorder opens exactly
//! the device chosen, with no name matching.

use gstreamer as gst;
use gstreamer::prelude::*;

use super::super::linux_plan::{RawAudioSource, RawCamera, cameras, microphones};
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
    let found = monitor.devices();
    monitor.stop();
    microphones_of(found)
}

/// The bar's microphones out of what a device monitor found (only the
/// `Audio/Source` devices are read; anything else is skipped).
#[must_use]
pub fn microphones_of(found: impl IntoIterator<Item = gst::Device>) -> Vec<MediaDevice> {
    let raw: Vec<RawAudioSource> = found
        .into_iter()
        .filter(|d| d.has_classes("Audio/Source"))
        .filter_map(|d| raw_source(&d))
        .collect();
    microphones(raw)
}

/// `--list-cameras` on Linux: the V4L2 and PipeWire cameras, so the bar can
/// offer them before the bubble ever opened. Empty when GStreamer cannot
/// list them.
#[must_use]
pub fn list_cameras() -> Vec<MediaDevice> {
    if super::init().is_err() {
        return Vec::new();
    }
    let monitor = gst::DeviceMonitor::new();
    let _ = monitor.add_filter(Some("Video/Source"), None);
    if monitor.start().is_err() {
        return Vec::new();
    }
    let found = monitor.devices();
    monitor.stop();
    cameras_of(found)
}

/// The bar's cameras out of what a device monitor found (only the
/// `Video/Source` devices are read).
#[must_use]
pub fn cameras_of(found: impl IntoIterator<Item = gst::Device>) -> Vec<MediaDevice> {
    let found: Vec<RawCamera> = found
        .into_iter()
        .filter(|d| d.has_classes("Video/Source"))
        .map(|d| raw_camera(&d))
        .collect();
    cameras(found)
}

/// A camera as the list names it: PipeWire's `node.name`, else the V4L2
/// path. Camera only on Wayland finds the camera to open by this same id
/// (`linux_plan::pick_camera`), so the list and the recorder never differ.
#[must_use]
pub fn raw_camera(device: &gst::Device) -> RawCamera {
    let props = device.properties();
    let text = |key: &str| props.as_ref().and_then(|p| p.get::<String>(key).ok());
    RawCamera {
        id: text("node.name").or_else(|| text("api.v4l2.path")).or_else(|| text("device.path")),
        display_name: device.display_name().to_string(),
    }
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
