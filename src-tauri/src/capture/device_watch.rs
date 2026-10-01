//! Live camera and microphone lists while the capture bar is up.
//!
//! The bar used to learn about a device that came or went only when a menu
//! opened or the overlay's webview fired `devicechange`, and WebKit fires
//! that only for a page that already holds a camera or microphone grant. A
//! phone reached through Continuity also arrives late: its camera and its
//! microphone are published separately, the microphone often a second or
//! more after the camera. So on macOS the helper runs in `--watch-devices`
//! mode for as long as the bar is up and prints both lists again on every
//! change; this module keeps that process and hands each new pair of lists
//! to the caller, which stores them and tells the bar.
//!
//! The watcher is started by the bar's first device read and stopped when
//! the overlays close. Closing its stdin is what ends the helper; it also
//! exits by itself after half an hour.

use serde::Deserialize;

use super::recording::{MediaDevice, tidy_devices};

/// One line from the watcher: both lists, tidied as the pickers show them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct DeviceLists {
    #[serde(default)]
    pub microphones: Vec<MediaDevice>,
    #[serde(default)]
    pub cameras: Vec<MediaDevice>,
}

/// The lists in one watcher line, or `None` for anything else (a `ready`
/// event from an older helper that does not know `--watch-devices` and
/// started a recording session instead, a diagnostic, a torn line).
#[must_use]
pub fn parse_lists(line: &str) -> Option<DeviceLists> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let obj = value.as_object()?;
    if !obj.contains_key("microphones") && !obj.contains_key("cameras") {
        return None;
    }
    let lists: DeviceLists = serde_json::from_value(value).ok()?;
    Some(DeviceLists {
        microphones: tidy_devices(lists.microphones),
        cameras: tidy_devices(lists.cameras),
    })
}

#[cfg(target_os = "macos")]
mod imp {
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Stdio};
    use std::sync::{Mutex, MutexGuard};

    use super::{DeviceLists, parse_lists};
    use crate::capture::recording;

    static WATCH: Mutex<Option<Child>> = Mutex::new(None);

    fn watch() -> MutexGuard<'static, Option<Child>> {
        WATCH.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Start the watcher unless one is already running. `on_lists` is called
    /// on the watcher's reader thread for every list it prints. Returns
    /// whether a watcher is running now.
    pub fn ensure_running(on_lists: impl Fn(DeviceLists) + Send + 'static) -> bool {
        let mut slot = watch();
        if let Some(child) = slot.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return true;
            }
            slot.take();
        }
        if !recording::macos::macos_at_least(13, 0) {
            return false;
        }
        let Some(mut program) = recording::macos::helper_command() else {
            return false;
        };
        let spawned = program
            .arg("--watch-devices")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(e) => {
                tracing::warn!("capture: device watcher did not start: {e}");
                return false;
            }
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return false;
        };
        std::thread::Builder::new()
            .name("capture-device-watch".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(lists) = parse_lists(&line) {
                        on_lists(lists);
                    }
                }
            })
            .ok();
        *slot = Some(child);
        true
    }

    /// Stop the watcher: its stdin closes and it exits; killed as well so a
    /// wedged one cannot linger.
    pub fn stop() {
        if let Some(mut child) = watch().take() {
            drop(child.stdin.take());
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::DeviceLists;

    /// Elsewhere the lists come from the camera window and the bar's own
    /// reads; there is no watcher.
    pub fn ensure_running(_on_lists: impl Fn(DeviceLists) + Send + 'static) -> bool {
        false
    }

    pub fn stop() {}
}

pub use imp::{ensure_running, stop};

#[cfg(test)]
mod tests {
    use super::*;

    /// The watcher's line with an iPhone nearby, keys sorted as the helper
    /// writes them: both lists arrive tidied, the phone's microphone once,
    /// still marked as a Continuity device, the default first.
    #[test]
    fn a_watcher_line_gives_both_lists_tidied() {
        let line = concat!(
            r#"{"cameras":[{"continuity":false,"id":"1F06","isDefault":true,"name":"FaceTime HD Camera"},"#,
            r#"{"continuity":true,"id":"A1B2-CONT","isDefault":false,"name":"Ahmad’s iPhone Camera"}],"#,
            r#""microphones":[{"continuity":false,"id":"BuiltInMicrophoneDevice","isDefault":false,"name":"MacBook Pro Microphone"},"#,
            r#"{"continuity":true,"id":"iPhoneMic-UID","isDefault":true,"name":"Ahmad’s iPhone Microphone"},"#,
            r#"{"continuity":true,"id":"iPhoneMic-UID","isDefault":false,"name":"Ahmad’s iPhone Microphone"}]}"#
        );
        let lists = parse_lists(line).expect("a watcher line parses");
        assert_eq!(lists.cameras.len(), 2);
        assert!(lists.cameras[1].continuity);
        assert_eq!(lists.microphones.len(), 2, "the phone's microphone shows once");
        assert_eq!(lists.microphones[0].id, "iPhoneMic-UID");
        assert!(lists.microphones[0].is_default && lists.microphones[0].continuity);
    }

    /// An older helper does not know `--watch-devices` and announces a
    /// recording session instead; that, a bare list, and junk are not lists.
    #[test]
    fn anything_but_a_watcher_line_is_ignored() {
        assert_eq!(parse_lists(r#"{"ok":true,"event":"ready"}"#), None);
        assert_eq!(parse_lists(r#"[{"id":"a","name":"Mic","isDefault":true}]"#), None);
        assert_eq!(parse_lists("microphone x is not connected"), None);
        assert_eq!(parse_lists(r#"{"microphones":[{"id":"a""#), None);
    }

    /// No devices at all is still an answer: the lists empty out (the last
    /// USB microphone unplugged), rather than keeping a stale list.
    #[test]
    fn an_empty_list_is_an_answer() {
        let lists = parse_lists(r#"{"cameras":[],"microphones":[]}"#).unwrap();
        assert_eq!(lists, DeviceLists::default());
    }
}
