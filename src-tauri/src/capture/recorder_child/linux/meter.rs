//! `--meter [deviceId]` on Linux: the capture bar's microphone level, read
//! with `pulsesrc` (PipeWire serves it too) and printed as the Swift
//! helper's meter prints it (`recorder_child::meter`). It holds the
//! microphone only until stdin closes; the app stops it before the recorder
//! opens the same microphone, so the device has one owner at a time.

use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use gstreamer as gst;
use gstreamer::prelude::*;

use super::super::linux_plan;
use super::super::meter::{LevelWindow, NO_MICROPHONE, failed_line, level_line};
use super::capture::{appsink, bus_error, floats, launch, play};
use super::say;
use crate::capture::recording::protocol::ready_line;

const PULL: gst::ClockTime = gst::ClockTime::from_mseconds(100);

fn print(line: &str) -> bool {
    let mut out = std::io::stdout();
    writeln!(out, "{line}").and_then(|()| out.flush()).is_ok()
}

/// Measure `device` (`None` = the default input) until stdin closes.
/// Returns the process's exit code.
#[must_use]
pub fn run(device: Option<&str>) -> i32 {
    let opened = super::init().and_then(|()| {
        let pipeline = launch(&linux_plan::meter_capture(device))?;
        let sink = appsink(&pipeline, linux_plan::AUDIO_SINK)?;
        play(&pipeline)?;
        Ok((pipeline, sink))
    });
    let (pipeline, sink) = match opened {
        Ok(opened) => opened,
        Err(detail) => {
            say(&format!("the microphone meter could not open the microphone: {detail}"));
            print(&failed_line(NO_MICROPHONE));
            return 1;
        }
    };
    if !print(&ready_line()) {
        let _ = pipeline.set_state(gst::State::Null);
        return 0;
    }
    // stdin closing (the app stopped the meter, or died) ends the meter.
    let closed = Arc::new(AtomicBool::new(false));
    std::thread::spawn({
        let closed = Arc::clone(&closed);
        move || {
            let mut sink = [0u8; 64];
            let mut stdin = std::io::stdin();
            while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
            closed.store(true, Ordering::SeqCst);
        }
    });
    let mut window = LevelWindow::new();
    let mut code = 0;
    while !closed.load(Ordering::SeqCst) {
        if let Some(detail) = bus_error(&pipeline) {
            say(&format!("the microphone meter stopped: {detail}"));
            print(&failed_line(NO_MICROPHONE));
            code = 1;
            break;
        }
        let Some(sample) = sink.try_pull_sample(PULL) else { continue };
        let Some(buffer) = sample.buffer() else { continue };
        let Ok(map) = buffer.map_readable() else { continue };
        for rms in window.push(&floats(map.as_slice()), 1) {
            if !print(&level_line(rms)) {
                closed.store(true, Ordering::SeqCst);
            }
        }
    }
    let _ = pipeline.set_state(gst::State::Null);
    code
}
