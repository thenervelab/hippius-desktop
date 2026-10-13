//! The capture session: one at a time, and every surface reads the same phase.
//!
//! The overlay, the Drive header's Capture menu, the tray and the recording
//! control bar can all drive a capture, and each needs to know whether one is
//! already running. They read the phase from here, via the
//! `capture_state_changed` event, rather than keeping their own flags — so a
//! second trigger mid-capture is refused in one place, and no two surfaces can
//! disagree about what is happening.
//!
//! The session ends when the file exists. Uploading it is the preview card's
//! business (keyed by the card's id), not the session's, so a new capture can
//! start while the last one is still uploading.

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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureEvent {
    Start {
        kind: CaptureKind,
        mode: CaptureMode,
    },
    /// The capture bar switched what is being captured (screenshot or
    /// recording; area, window or screen) before anything was chosen.
    SetMode {
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
    /// Throw the recording away and start again on the same selection. The
    /// recorder is cancelled first; the session goes back to starting one.
    Restart,
    /// The capture file is written, and the session is over. The upload runs
    /// on its own, owned by the preview card, so a new capture can start while
    /// a long recording is still uploading.
    Captured,
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
    /// Cancel while the recording is being closed to a file. The stop task
    /// owns the recorder by then; cancelling underneath it would strand a
    /// finished MP4 in the temp folder with nobody left to deliver or remove it.
    #[error("The recording is already being saved.")]
    AlreadySaving,
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
        // Starting, or the capture bar switching mode before anything is
        // chosen, both land in Selecting.
        (P::Idle, E::Start { kind, mode }) | (P::Selecting { .. }, E::SetMode { kind, mode }) => Ok(P::Selecting { kind, mode }),
        (_, E::Start { .. }) => Err(TransitionError::AlreadyActive),

        // Screenshot: select → grab pixels → done (the card uploads it).
        (P::Selecting { kind: K::Screenshot, .. }, E::Selected) => Ok(P::Capturing { kind: K::Screenshot }),

        // Recording: select → start encoder → (pause/resume)* → finalize → done.
        // Restart throws the recording away and starts the recorder again.
        (P::Selecting { kind: K::Recording, .. }, E::Selected) | (P::Recording { .. } | P::Paused { .. }, E::Restart) => {
            Ok(P::Capturing { kind: K::Recording })
        }
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

        // Every way a session ends: the file exists, or it never will.
        (P::Capturing { kind: K::Screenshot } | P::Finalizing, E::Captured)
        | (P::Selecting { .. } | P::Capturing { .. } | P::Recording { .. } | P::Paused { .. }, E::Failed | E::Cancel)
        | (P::Finalizing, E::Failed) => Ok(P::Idle),
        (P::Finalizing, E::Cancel) => Err(TransitionError::AlreadySaving),

        _ => Err(TransitionError::NotApplicable),
    }
}

/// Whether recording start number `start` has been overtaken by a newer
/// one (`latest`, the last number handed out): a start cancelled while the
/// desktop's dialog was up, then Record pressed again.
#[must_use]
pub const fn start_superseded(start: u64, latest: u64) -> bool {
    start != latest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_latest_recording_start_owns_the_session() {
        assert!(!start_superseded(3, 3));
        assert!(start_superseded(2, 3), "Record pressed again while the dialog was up");
    }

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
        assert_eq!(run(&[SHOT, Selected, Captured]), Ok(CapturePhase::Idle));
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
        assert_eq!(run(&[SHOT, Selected, Captured]), Ok(CapturePhase::Idle));
    }

    /// The upload runs on its own once the file exists: a long recording
    /// still uploading must not make the next capture a silent no-op.
    #[test]
    fn a_new_capture_can_start_while_the_last_one_uploads() {
        use CaptureEvent::*;
        let after_shot = run(&[SHOT, Selected, Captured]).unwrap();
        assert!(transition(after_shot, SHOT).is_ok());
        let after_recording = run(&[REC, Selected, RecordingStarted { microphone: false }, Stop, Captured]).unwrap();
        assert!(transition(after_recording, REC).is_ok());
    }

    /// Every phase but Idle has a way out, so no failure can strand a session.
    #[test]
    fn every_live_phase_can_end() {
        use CaptureEvent::*;
        for prefix in [
            &[SHOT][..],
            &[SHOT, Selected][..],
            &[REC, Selected][..],
            &[REC, Selected, RecordingStarted { microphone: false }][..],
            &[REC, Selected, RecordingStarted { microphone: false }, Pause][..],
            &[REC, Selected, RecordingStarted { microphone: false }, Stop][..],
        ] {
            let phase = run(prefix).unwrap();
            assert_eq!(transition(phase, Failed), Ok(CapturePhase::Idle), "{phase:?}");
        }
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
    }

    /// The stop task owns the recorder once the phase is Finalizing; a cancel
    /// then would leave the finished file with nobody to deliver it.
    #[test]
    fn cancel_is_refused_while_the_recording_is_being_saved() {
        use CaptureEvent::*;
        assert_eq!(
            run(&[REC, Selected, RecordingStarted { microphone: false }, Stop, Cancel]),
            Err(TransitionError::AlreadySaving)
        );
        // A failed finalize still ends the session.
        assert_eq!(
            run(&[REC, Selected, RecordingStarted { microphone: false }, Stop, Failed]),
            Ok(CapturePhase::Idle)
        );
    }

    #[test]
    fn restart_goes_back_to_starting_a_recording_from_recording_or_paused() {
        use CaptureEvent::*;
        let starting = Ok(CapturePhase::Capturing {
            kind: CaptureKind::Recording,
        });
        assert_eq!(run(&[REC, Selected, RecordingStarted { microphone: true }, Restart]), starting);
        assert_eq!(run(&[REC, Selected, RecordingStarted { microphone: true }, Pause, Restart]), starting);
        // And the restarted recording carries on as a normal one.
        assert_eq!(
            run(&[
                REC,
                Selected,
                RecordingStarted { microphone: true },
                Restart,
                RecordingStarted { microphone: false }
            ]),
            Ok(CapturePhase::Recording {
                elapsed_secs: 0,
                microphone: false
            })
        );
        for prefix in [
            &[SHOT][..],
            &[SHOT, Selected][..],
            &[REC, Selected, RecordingStarted { microphone: false }, Stop][..],
        ] {
            let phase = run(prefix).unwrap();
            assert_eq!(transition(phase, Restart), Err(TransitionError::NotApplicable), "{phase:?}");
        }
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

    #[test]
    fn the_bar_switches_mode_only_while_selecting() {
        use CaptureEvent::*;
        let to_window_recording = SetMode {
            kind: CaptureKind::Recording,
            mode: CaptureMode::Window,
        };
        assert_eq!(
            run(&[SHOT, to_window_recording]),
            Ok(CapturePhase::Selecting {
                kind: CaptureKind::Recording,
                mode: CaptureMode::Window
            })
        );
        assert_eq!(transition(CapturePhase::Idle, to_window_recording), Err(TransitionError::NotApplicable));
        assert_eq!(run(&[SHOT, Selected, to_window_recording]), Err(TransitionError::NotApplicable));
        assert_eq!(
            run(&[REC, Selected, RecordingStarted { microphone: false }, to_window_recording]),
            Err(TransitionError::NotApplicable)
        );
    }

    /// A stale event from a finished session (a late overlay click, a
    /// duplicate "done") must not advance a new one.
    #[test]
    fn an_event_out_of_order_is_refused_and_changes_nothing() {
        use CaptureEvent::*;
        for event in [Selected, Captured, Failed, Cancel, Pause, Resume, Stop, Restart] {
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
