//! `--probe` on Linux: whether this machine can record, asked once per
//! launch by the app (`recording::linux`). GStreamer's registry says which
//! encoders and elements are installed; on Wayland the ScreenCast portal is
//! asked whether it exists (no dialog). The same probe finds the H.264 and
//! AAC decoders the file viewer's player needs (`video_stream`).

use gstreamer as gst;

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
    probe.h264_decoder = decoder_for(&gst::Caps::new_empty_simple("video/x-h264"), gst::ElementFactoryType::MEDIA_VIDEO);
    // AAC is MPEG-4 audio; an MP3-only decoder (mpegversion 1) does not count.
    let aac = gst::Caps::builder("audio/mpeg").field("mpegversion", 4i32).build();
    probe.aac_decoder = decoder_for(&aac, gst::ElementFactoryType::MEDIA_AUDIO);
    if wayland {
        probe.screencast_portal = Some(super::portal::screencast_available());
    }
    probe
}

/// The highest-ranked decoder of rank MARGINAL or more that takes `caps`,
/// which is what GStreamer's `decodebin` (and so WebKitGTK's player) would
/// pick. By caps, not by name, so `avdec_h264`, `openh264dec`, `vah264dec`
/// and any other all count.
fn decoder_for(caps: &gst::Caps, kind: gst::ElementFactoryType) -> Option<String> {
    use gst::prelude::*;
    let mut factories: Vec<gst::ElementFactory> =
        gst::ElementFactory::factories_with_type(gst::ElementFactoryType::DECODER | kind, gst::Rank::MARGINAL)
            .into_iter()
            .filter(|f| f.can_sink_any_caps(caps))
            .collect();
    factories.sort_by_key(|f| std::cmp::Reverse(f.rank()));
    factories.first().map(|f| f.name().to_string())
}
