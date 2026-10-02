//! Platform-free decisions about the recorder's sound sources, kept apart
//! from the WASAPI calls so they are tested on every OS.
//!
//! - **Which system audio:** Windows 11 can record what every process plays
//!   EXCEPT one process tree (process loopback). Hippius records the system
//!   that way with its own tree left out, so its notification sounds and
//!   anything its webviews play stay out of the user's recording. Older
//!   builds, or a refusal, fall back to plain loopback of the default output.
//! - **When a packet was heard:** WASAPI stamps capture packets with their
//!   QPC position. A process-loopback client may report none; such a packet
//!   is stamped from the clock when it was read, minus its own length, so
//!   it still lines up with the picture.

/// The environment variable the app sets on the recorder child: its own
/// process id, the tree process loopback leaves out. Absent when the child is
/// driven by hand, which then records the whole output.
pub const APP_PID_ENV: &str = "HIPPIUS_CAPTURE_APP_PID";

/// The app's pid from [`APP_PID_ENV`]'s value.
#[must_use]
pub fn app_pid_from(value: Option<&str>) -> Option<u32> {
    value?.trim().parse().ok().filter(|pid| *pid != 0)
}

/// The first build whose process loopback leaves a process tree out
/// (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`): Windows 11.
pub const PROCESS_LOOPBACK_FLOOR_BUILD: u32 = 22000;

/// How the system's sound is captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemAudioRoute {
    /// Everything the computer plays except process `pid` and its children
    /// (the app and its webviews).
    ExcludingProcessTree { pid: u32 },
    /// Everything the default output plays, Hippius included.
    WholeOutput,
}

/// The route for this Windows `build`, leaving out `app_pid` (the process
/// that started the recorder) where the build can.
#[must_use]
pub fn system_audio_route(build: Option<u32>, app_pid: Option<u32>) -> SystemAudioRoute {
    match (build, app_pid) {
        (Some(build), Some(pid)) if build >= PROCESS_LOOPBACK_FLOOR_BUILD && pid != 0 => SystemAudioRoute::ExcludingProcessTree { pid },
        _ => SystemAudioRoute::WholeOutput,
    }
}

/// When a packet of `frames` frames at `rate` Hz began, in microseconds on
/// the capture clock: its QPC position (100 ns units) when the device gave
/// one, else the moment it was read (`now_us`) less its length.
#[must_use]
pub fn packet_time_us(qpc_hns: u64, now_us: u64, frames: u32, rate: u32) -> u64 {
    if qpc_hns > 0 {
        return qpc_hns / 10;
    }
    let length = if rate == 0 { 0 } else { u64::from(frames) * 1_000_000 / u64::from(rate) };
    now_us.saturating_sub(length)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_11_leaves_the_app_out_and_older_builds_record_everything() {
        assert_eq!(
            system_audio_route(Some(22631), Some(4242)),
            SystemAudioRoute::ExcludingProcessTree { pid: 4242 }
        );
        assert_eq!(
            system_audio_route(Some(22000), Some(7)),
            SystemAudioRoute::ExcludingProcessTree { pid: 7 }
        );
        assert_eq!(
            system_audio_route(Some(19045), Some(4242)),
            SystemAudioRoute::WholeOutput,
            "Windows 10 22H2"
        );
        assert_eq!(system_audio_route(None, Some(4242)), SystemAudioRoute::WholeOutput, "unknown build");
        assert_eq!(
            system_audio_route(Some(26100), None),
            SystemAudioRoute::WholeOutput,
            "no app to leave out"
        );
        assert_eq!(
            system_audio_route(Some(26100), Some(0)),
            SystemAudioRoute::WholeOutput,
            "pid 0 is the idle process"
        );
    }

    #[test]
    fn the_app_pid_is_read_from_its_variable() {
        assert_eq!(app_pid_from(Some("4242")), Some(4242));
        assert_eq!(app_pid_from(Some(" 17 ")), Some(17));
        assert_eq!(app_pid_from(Some("0")), None);
        assert_eq!(app_pid_from(Some("nope")), None);
        assert_eq!(app_pid_from(None), None);
    }

    #[test]
    fn a_packet_is_stamped_by_its_qpc_position_or_by_when_it_was_read() {
        assert_eq!(packet_time_us(12_345_670, 999_999_999, 480, 48_000), 1_234_567);
        // No position: read at 1 s, 480 frames at 48 kHz began 10 ms earlier.
        assert_eq!(packet_time_us(0, 1_000_000, 480, 48_000), 990_000);
        assert_eq!(packet_time_us(0, 5_000, 48_000, 48_000), 0, "never before the clock began");
        assert_eq!(packet_time_us(0, 5_000, 480, 0), 5_000);
    }
}
