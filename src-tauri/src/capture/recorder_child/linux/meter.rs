//! `--meter [deviceId]` on Linux: the capture bar's microphone level, read
//! with `pulsesrc` (PipeWire serves it too). The window, the lines and the
//! stdin stop are the shared `recorder_child::meter`, so Windows, Linux and
//! the Swift helper print the same thing; this only opens the source and
//! hands its samples over. The app stops the meter before the recorder opens
//! the same microphone, so the device has one owner at a time.

use gstreamer as gst;
use gstreamer::prelude::*;

use super::super::linux_plan;
use super::super::meter;
use super::capture::{appsink, bus_error, floats, launch, play};
use super::say;

/// What the meter says when the microphone does not open: Rust's words, the
/// GStreamer detail goes to stderr.
const NO_MICROPHONE: &str = "The microphone could not be opened.";

const PULL: gst::ClockTime = gst::ClockTime::from_mseconds(100);

/// Measure `device` (`None` = the default input) until stdin closes.
/// Returns the process's exit code.
#[must_use]
pub fn run(device: Option<String>) -> i32 {
    meter::serve(std::io::BufReader::new(std::io::stdin()), std::io::stdout(), move || {
        let opened = super::init().and_then(|()| {
            let pipeline = launch(&linux_plan::meter_capture(device.as_deref()))?;
            let sink = appsink(&pipeline, linux_plan::AUDIO_SINK)?;
            play(&pipeline)?;
            Ok((pipeline, sink))
        });
        let (pipeline, sink) = opened.map_err(|detail| {
            say(&format!("the microphone meter could not open the microphone: {detail}"));
            NO_MICROPHONE.to_string()
        })?;
        let reader: meter::Reader = Box::new(move |stop, sink_samples| {
            let result = loop {
                if stop.load(std::sync::atomic::Ordering::SeqCst) {
                    break Ok(());
                }
                if let Some(detail) = bus_error(&pipeline) {
                    say(&format!("the microphone meter stopped: {detail}"));
                    break Err(NO_MICROPHONE.to_string());
                }
                let Some(sample) = sink.try_pull_sample(PULL) else { continue };
                let Some(buffer) = sample.buffer() else { continue };
                let Ok(map) = buffer.map_readable() else { continue };
                sink_samples(&floats(map.as_slice()));
            };
            let _ = pipeline.set_state(gst::State::Null);
            result
        });
        Ok(reader)
    })
}
