//! `--watch-devices` on Linux: the bar's lists stay live while it is up.
//! One GStreamer device monitor watches both `Audio/Source` (PipeWire or
//! PulseAudio inputs) and `Video/Source` (V4L2 and PipeWire cameras); its
//! bus says when a device is added or removed, which nudges the shared loop
//! ([`super::super::watch`]). A new default input is caught by the loop's
//! slow poll: `DeviceChanged` needs GStreamer 1.16 bindings this build does
//! not switch on. The lists are read from the running monitor, with the same
//! rules `--list-microphones` and `--list-cameras` use.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use gstreamer as gst;
use gstreamer::prelude::*;

use super::super::watch::{self, Timing, Wake};
use super::{devices, say};

/// How long one wait on the monitor's bus lasts before the thread looks at
/// its stop flag.
const POP: gst::ClockTime = gst::ClockTime::from_mseconds(200);

/// Watch until stdin closes. Returns the process's exit code.
#[must_use]
pub fn run() -> i32 {
    if super::init().is_err() {
        // Without GStreamer there are no lists to keep live: print the
        // empty answer once, as `--list-*` would, and wait for the bar.
        let (tx, rx) = mpsc::channel();
        watch::stop_on_stdin_close(tx);
        let none: [serde_json::Value; 0] = [];
        watch::serve(&rx, || watch::line(&none, &none), std::io::stdout().lock(), Timing::default());
        return 1;
    }
    let monitor = gst::DeviceMonitor::new();
    let _ = monitor.add_filter(Some("Audio/Source"), None);
    let _ = monitor.add_filter(Some("Video/Source"), None);
    if monitor.start().is_err() {
        say("watch: the device monitor did not start; polling instead");
    }

    let (tx, rx) = mpsc::channel();
    watch::stop_on_stdin_close(tx.clone());
    let stop = Arc::new(AtomicBool::new(false));
    let bus = monitor.bus();
    let listener = std::thread::Builder::new()
        .name("watch-bus".into())
        .spawn({
            let stop = Arc::clone(&stop);
            move || {
                let kinds = [gst::MessageType::DeviceAdded, gst::MessageType::DeviceRemoved];
                while !stop.load(Ordering::SeqCst) {
                    if bus.timed_pop_filtered(POP, &kinds).is_some() && tx.send(Wake::Changed).is_err() {
                        break;
                    }
                }
            }
        })
        .ok();

    watch::serve(
        &rx,
        || {
            let found = monitor.devices();
            let cameras = devices::cameras_of(found.iter().cloned());
            let microphones = devices::microphones_of(found);
            watch::line(&cameras, &microphones)
        },
        std::io::stdout().lock(),
        Timing::default(),
    );

    stop.store(true, Ordering::SeqCst);
    if let Some(listener) = listener {
        let _ = listener.join();
    }
    monitor.stop();
    0
}
