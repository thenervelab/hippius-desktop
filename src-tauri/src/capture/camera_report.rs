//! The camera page's account of opening the camera, in the app log.
//!
//! When the bubble shows only its placeholder, nothing on screen says why:
//! the camera may be missing from WebKit's list, `getUserMedia` may have
//! failed or never answered, or a stream may have opened that never
//! delivered a frame. The camera page reports each step
//! (`capture_camera_report`) and this logs it with a `camera:` prefix in
//! `~/.hippius/logs`, at `warn` for a failure and `info` otherwise.
//!
//! The page sends device names, constraints, error names and messages and
//! track state; nothing else. Each field is cut to [`MAX_DETAIL`] characters
//! with control characters removed, and [`Throttle`] keeps a page that loops
//! (a camera reopened again and again) from filling the log.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// The longest detail logged, in characters.
pub const MAX_DETAIL: usize = 600;
/// The same step is logged at most once in this long.
pub const STEP_GAP: Duration = Duration::from_secs(1);
/// At most this many reports in [`WINDOW`]; the rest are counted, and the
/// count is logged with the next report let through.
pub const PER_WINDOW: usize = 40;
pub const WINDOW: Duration = Duration::from_mins(1);

/// How loud a step is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warn,
}

/// Steps that mean the camera did not work (or stopped working).
const WARN_STEPS: &[&str] = &["no-media-devices", "error", "no-frames", "gave-up", "track-ended", "track-muted"];

#[must_use]
pub fn severity(step: &str) -> Severity {
    if WARN_STEPS.contains(&step) { Severity::Warn } else { Severity::Info }
}

/// A step name as logged: lowercase letters, digits and `-`, at most 32,
/// else `unknown`, so the page can never write a misleading prefix.
#[must_use]
pub fn clean_step(step: &str) -> String {
    let ok = !step.is_empty() && step.len() <= 32 && step.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok { step.to_string() } else { "unknown".to_string() }
}

/// A detail as logged: one line, control characters turned into spaces,
/// at most [`MAX_DETAIL`] characters (cut on a character boundary).
#[must_use]
pub fn clean_detail(detail: &str) -> String {
    let line: String = detail.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let line = line.trim();
    if line.chars().count() <= MAX_DETAIL {
        return line.to_string();
    }
    let cut: String = line.chars().take(MAX_DETAIL).collect();
    format!("{cut}...")
}

/// What the throttle says about one report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admit {
    /// Log it; `dropped` reports were left out since the last one logged.
    Log {
        dropped: usize,
    },
    Skip,
}

/// Rate limits for the camera page's reports.
#[derive(Debug)]
pub struct Throttle {
    last: HashMap<String, Instant>,
    window_start: Option<Instant>,
    in_window: usize,
    dropped: usize,
}

impl Default for Throttle {
    fn default() -> Self {
        Self::new()
    }
}

impl Throttle {
    #[must_use]
    pub fn new() -> Self {
        Self {
            last: HashMap::new(),
            window_start: None,
            in_window: 0,
            dropped: 0,
        }
    }

    /// Whether the report of `step` at `now` is logged.
    pub fn admit(&mut self, step: &str, now: Instant) -> Admit {
        if self.window_start.is_none_or(|start| now.duration_since(start) >= WINDOW) {
            self.window_start = Some(now);
            self.in_window = 0;
        }
        let too_soon = self.last.get(step).is_some_and(|at| now.duration_since(*at) < STEP_GAP);
        if too_soon || self.in_window >= PER_WINDOW {
            self.dropped += 1;
            return Admit::Skip;
        }
        self.last.insert(step.to_string(), now);
        self.in_window += 1;
        Admit::Log {
            dropped: std::mem::take(&mut self.dropped),
        }
    }
}

static THROTTLE: LazyLock<Mutex<Throttle>> = LazyLock::new(|| Mutex::new(Throttle::new()));

/// One step of the camera page opening (or failing to open) the camera.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
pub fn capture_camera_report(step: String, detail: String) {
    let step = clean_step(&step);
    let admit = THROTTLE.lock().map_or(Admit::Log { dropped: 0 }, |mut t| t.admit(&step, Instant::now()));
    let Admit::Log { dropped } = admit else {
        return;
    };
    let detail = clean_detail(&detail);
    match severity(&step) {
        Severity::Warn => tracing::warn!(step = %step, dropped, "camera: {step}: {detail}"),
        Severity::Info => tracing::info!(step = %step, dropped, "camera: {step}: {detail}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_are_warnings_and_progress_is_info() {
        for step in ["error", "no-frames", "no-media-devices", "gave-up", "track-ended", "track-muted"] {
            assert_eq!(severity(step), Severity::Warn, "{step}");
        }
        for step in ["start", "devices", "request", "opened", "playing"] {
            assert_eq!(severity(step), Severity::Info, "{step}");
        }
    }

    #[test]
    fn a_step_name_cannot_carry_anything_but_a_plain_name() {
        assert_eq!(clean_step("no-frames"), "no-frames");
        for bad in ["", "Error", "error: forged", "a\nb", &"x".repeat(33)] {
            assert_eq!(clean_step(bad), "unknown", "{bad:?}");
        }
    }

    #[test]
    fn a_detail_is_one_bounded_line() {
        assert_eq!(
            clean_detail(" NotReadableError\nCould not start\tvideo source "),
            "NotReadableError Could not start video source"
        );
        let long = "é".repeat(MAX_DETAIL + 10);
        let cut = clean_detail(&long);
        assert_eq!(cut.chars().count(), MAX_DETAIL + 3);
        assert!(cut.ends_with("..."));
    }

    /// A page reopening its camera in a loop must not fill the log: the
    /// same step repeats only after the gap, all steps share a cap per
    /// minute, and what was left out is counted on the next line logged.
    #[test]
    fn repeated_reports_are_throttled_and_counted() {
        let mut t = Throttle::new();
        let t0 = Instant::now();
        assert_eq!(t.admit("request", t0), Admit::Log { dropped: 0 });
        assert_eq!(t.admit("request", t0 + Duration::from_millis(100)), Admit::Skip);
        assert_eq!(t.admit("opened", t0 + Duration::from_millis(100)), Admit::Log { dropped: 1 });
        assert_eq!(t.admit("request", t0 + STEP_GAP), Admit::Log { dropped: 0 });

        let mut t = Throttle::new();
        let mut logged = 0;
        for i in 0..200u64 {
            if matches!(t.admit(&format!("s{i}"), t0 + Duration::from_millis(i)), Admit::Log { .. }) {
                logged += 1;
            }
        }
        assert_eq!(logged, PER_WINDOW);
        assert_eq!(
            t.admit("later", t0 + WINDOW + Duration::from_secs(1)),
            Admit::Log { dropped: 200 - PER_WINDOW }
        );
    }
}
