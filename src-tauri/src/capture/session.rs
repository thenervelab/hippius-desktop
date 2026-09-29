//! The capture session: one at a time, and every surface reads the same phase.
//!
//! The overlay, the Drive header's Capture menu, the tray and the recording
//! control bar can all drive a capture, and each needs to know whether one is
//! already running. They read the phase from here, via the
//! `capture_state_changed` event, rather than keeping their own flags — so a
//! second trigger mid-capture is refused in one place, and no two surfaces can
//! disagree about what is happening.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureKind {
    Screenshot,
    Recording,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureMode {
    /// A rectangle the user drags.
    Area,
    /// One window, picked by hovering and clicking.
    Window,
    /// A whole display.
    Screen,
}

/// Where a capture is. Serialised as `{ "phase": "selecting", "kind": …, "mode": … }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum CapturePhase {
    Idle,
    /// The overlay is up, waiting for the user to choose what to capture.
    Selecting {
        kind: CaptureKind,
        mode: CaptureMode,
    },
    /// A screenshot: the choice is made; pixels are being read.
    Capturing {
        kind: CaptureKind,
    },
    /// A recording is running.
    Recording {
        /// Wall-clock seconds since the recording started (not counting pause).
        #[serde(rename = "elapsedSecs")]
        elapsed_secs: u64,
        microphone: bool,
    },
    /// A recording is paused; the file is still open.
    Paused {
        #[serde(rename = "elapsedSecs")]
        elapsed_secs: u64,
        microphone: bool,
    },
    /// The recording is being closed to an MP4 on disk.
    Finalizing,
    /// The file exists locally and is being uploaded and shared.
    Delivering {
        kind: CaptureKind,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureEvent {
    Start {
        kind: CaptureKind,
        mode: CaptureMode,
    },
    /// The user made a choice in the overlay.
    Selected,
    /// A recording has begun writing frames.
    RecordingStarted {
        microphone: bool,
    },
    /// Elapsed-time tick while recording (or paused) so the control bar stays accurate.
    Tick {
        elapsed_secs: u64,
    },
    Pause,
    Resume,
    /// The user asked to stop; the encoder is finishing the file.
    Stop,
    /// The capture file is written.
    Captured,
    /// Delivery finished, successfully or not. Either way the session is over:
    /// a failed upload keeps its file and says where, it does not stay open.
    Finished,
    /// The capture itself failed (no permission, no pixels, helper crashed).
    Failed,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TransitionError {
    /// A capture is already running. The caller brings it forward rather than
    /// starting another; two overlays on one screen would each capture the other.
    #[error("A capture is already in progress.")]
    AlreadyActive,
    /// Cancel after the file exists. The upload is already in flight, and
    /// abandoning it half-way would leave a partial file in the drive.
    #[error("The capture is already uploading.")]
    TooLateToCancel,
    #[error("That capture step does not apply now.")]
    NotApplicable,
}

/// The next phase, or why the event does not apply.
///
/// # Errors
///
/// [`TransitionError`] when `event` does not apply to `phase`; `phase` is
/// then unchanged.
pub fn transition(phase: CapturePhase, event: CaptureEvent) -> Result<CapturePhase, TransitionError> {
    use CaptureEvent as E;
    use CaptureKind as K;
    use CapturePhase as P;
    match (phase, event) {
        (P::Idle, E::Start { kind, mode }) => Ok(P::Selecting { kind, mode }),
        (_, E::Start { .. }) => Err(TransitionError::AlreadyActive),

        // Screenshot: select → grab pixels → deliver.
        (P::Selecting { kind: K::Screenshot, .. }, E::Selected) => Ok(P::Capturing { kind: K::Screenshot }),
        (P::Capturing { kind: K::Screenshot }, E::Captured) => Ok(P::Delivering { kind: K::Screenshot }),

        // Recording: select → start encoder → (pause/resume)* → finalize → deliver.
        (P::Selecting { kind: K::Recording, .. }, E::Selected) => Ok(P::Capturing { kind: K::Recording }),
        (P::Capturing { kind: K::Recording }, E::RecordingStarted { microphone }) => Ok(P::Recording { elapsed_secs: 0, microphone }),
        // Pausing, or a tick while paused, lands in Paused with the latest time.
        (P::Recording { elapsed_secs, microphone }, E::Pause) | (P::Paused { microphone, .. }, E::Tick { elapsed_secs }) => {
            Ok(P::Paused { elapsed_secs, microphone })
        }
        // Resuming, or a tick while recording, lands in Recording likewise.
        (P::Paused { elapsed_secs, microphone }, E::Resume) | (P::Recording { microphone, .. }, E::Tick { elapsed_secs }) => {
            Ok(P::Recording { elapsed_secs, microphone })
        }
        (P::Recording { .. } | P::Paused { .. }, E::Stop) => Ok(P::Finalizing),
        (P::Finalizing, E::Captured) => Ok(P::Delivering { kind: K::Recording }),

        // Every way a session ends before/after the file exists.
        (P::Delivering { .. }, E::Finished)
        | (P::Selecting { .. } | P::Capturing { .. } | P::Recording { .. } | P::Paused { .. } | P::Finalizing, E::Failed | E::Cancel) => Ok(P::Idle),
        (P::Delivering { .. }, E::Cancel) => Err(TransitionError::TooLateToCancel),

        _ => Err(TransitionError::NotApplicable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHOT: CaptureEvent = CaptureEvent::Start {
        kind: CaptureKind::Screenshot,
        mode: CaptureMode::Area,
    };
    const REC: CaptureEvent = CaptureEvent::Start {
        kind: CaptureKind::Recording,
        mode: CaptureMode::Screen,
    };

    fn run(events: &[CaptureEvent]) -> Result<CapturePhase, TransitionError> {
        events.iter().try_fold(CapturePhase::Idle, |phase, &event| transition(phase, event))
    }

    #[test]
    fn a_screenshot_runs_start_to_finish_and_returns_to_idle() {
        use CaptureEvent::*;
        assert_eq!(run(&[SHOT, Selected, Captured, Finished]), Ok(CapturePhase::Idle));
    }

    #[test]
    fn each_screenshot_step_reports_where_it_is() {
        use CaptureEvent::*;
        assert_eq!(
            run(&[SHOT]),
            Ok(CapturePhase::Selecting {
                kind: CaptureKind::Screenshot,
                mode: CaptureMode::Area
            })
        );
        assert_eq!(
            run(&[SHOT, Selected]),
            Ok(CapturePhase::Capturing {
                kind: CaptureKind::Screenshot
            })
        );
        assert_eq!(
            run(&[SHOT, Selected, Captured]),
            Ok(CapturePhase::Delivering {
                kind: CaptureKind::Screenshot
            })
        );
    }

    #[test]
    fn a_recording_runs_start_to_finish_with_pause() {
        use CaptureEvent::*;
        assert_eq!(
            run(&[
                REC,
                Selected,
                RecordingStarted { microphone: true },
                Tick { elapsed_secs: 3 },
                Pause,
                Resume,
                Stop,
                Captured,
                Finished,
            ]),
            Ok(CapturePhase::Idle)
        );
    }

    #[test]
    fn recording_phases_carry_elapsed_and_mic() {
        use CaptureEvent::*;
        assert_eq!(
            run(&[REC, Selected, RecordingStarted { microphone: true }, Tick { elapsed_secs: 12 }]),
            Ok(CapturePhase::Recording {
                elapsed_secs: 12,
                microphone: true
            })
        );
        assert_eq!(
            run(&[REC, Selected, RecordingStarted { microphone: false }, Pause]),
            Ok(CapturePhase::Paused {
                elapsed_secs: 0,
                microphone: false
            })
        );
        assert_eq!(
            run(&[REC, Selected, RecordingStarted { microphone: true }, Stop]),
            Ok(CapturePhase::Finalizing)
        );
    }

    /// Two overlays on one screen would each end up in the other's capture.
    #[test]
    fn a_second_start_is_refused_in_every_live_phase() {
        use CaptureEvent::*;
        for prefix in [
            &[SHOT][..],
            &[SHOT, Selected][..],
            &[SHOT, Selected, Captured][..],
            &[REC, Selected, RecordingStarted { microphone: false }][..],
            &[REC, Selected, RecordingStarted { microphone: false }, Pause][..],
            &[REC, Selected, RecordingStarted { microphone: false }, Stop][..],
        ] {
            let phase = run(prefix).unwrap();
            assert_eq!(transition(phase, SHOT), Err(TransitionError::AlreadyActive), "{phase:?}");
        }
    }

    #[test]
    fn cancel_ends_the_session_before_the_file_exists() {
        use CaptureEvent::*;
        assert_eq!(run(&[SHOT, Cancel]), Ok(CapturePhase::Idle));
        assert_eq!(run(&[SHOT, Selected, Cancel]), Ok(CapturePhase::Idle));
        assert_eq!(
            run(&[REC, Selected, RecordingStarted { microphone: false }, Cancel]),
            Ok(CapturePhase::Idle)
        );
        assert_eq!(
            run(&[REC, Selected, RecordingStarted { microphone: false }, Stop, Cancel]),
            Ok(CapturePhase::Idle)
        );
    }

    #[test]
    fn cancel_is_refused_once_the_upload_has_started() {
        use CaptureEvent::*;
        assert_eq!(run(&[SHOT, Selected, Captured, Cancel]), Err(TransitionError::TooLateToCancel));
        assert_eq!(
            run(&[REC, Selected, RecordingStarted { microphone: false }, Stop, Captured, Cancel]),
            Err(TransitionError::TooLateToCancel)
        );
    }

    #[test]
    fn a_failed_capture_ends_the_session() {
        use CaptureEvent::*;
        assert_eq!(run(&[SHOT, Failed]), Ok(CapturePhase::Idle));
        assert_eq!(run(&[SHOT, Selected, Failed]), Ok(CapturePhase::Idle));
        assert_eq!(
            run(&[REC, Selected, RecordingStarted { microphone: true }, Failed]),
            Ok(CapturePhase::Idle)
        );
    }

    /// A stale event from a finished session (a late overlay click, a
    /// duplicate "done") must not advance a new one.
    #[test]
    fn an_event_out_of_order_is_refused_and_changes_nothing() {
        use CaptureEvent::*;
        for event in [Selected, Captured, Finished, Failed, Cancel, Pause, Resume, Stop] {
            assert_eq!(transition(CapturePhase::Idle, event), Err(TransitionError::NotApplicable), "{event:?}");
        }
        assert_eq!(run(&[SHOT, Captured]), Err(TransitionError::NotApplicable));
        assert_eq!(run(&[SHOT, Pause]), Err(TransitionError::NotApplicable));
    }

    /// The frontend reads this shape off `capture_state_changed`.
    #[test]
    fn serialises_the_phase_as_a_tagged_object() {
        let phase = CapturePhase::Selecting {
            kind: CaptureKind::Screenshot,
            mode: CaptureMode::Window,
        };
        assert_eq!(
            serde_json::to_value(phase).unwrap(),
            serde_json::json!({ "phase": "selecting", "kind": "screenshot", "mode": "window" })
        );
        assert_eq!(serde_json::to_value(CapturePhase::Idle).unwrap(), serde_json::json!({ "phase": "idle" }));
        assert_eq!(
            serde_json::to_value(CapturePhase::Recording {
                elapsed_secs: 5,
                microphone: true
            })
            .unwrap(),
            serde_json::json!({ "phase": "recording", "elapsedSecs": 5, "microphone": true })
        );
        assert_eq!(
            serde_json::to_value(CapturePhase::Finalizing).unwrap(),
            serde_json::json!({ "phase": "finalizing" })
        );
    }
}
