//! Per-drive record of a refused empty server listing, as the empty-drive
//! prompt shows it.
//!
//! ## What hcfs reports
//!
//! hcfs-client refuses to apply an empty server listing on top of a
//! non-empty synced baseline: following it would delete every local copy.
//! The cycle fails with `SyncError::SuspiciousEmptyRemote { synced_count }`
//! before anything is planned, and the runner re-reports it as a cycle
//! error on every backoff retry while the listing stays empty. Nothing is
//! deleted until the owner confirms the drive really is empty
//! (`DriveManager::confirm_empty_remote`, a marker the next cycle reads at
//! its start and spends when it accepts the empty listing). A shared-drive
//! member cannot confirm: an empty listing may mean the owner deleted the
//! drive, and this device may hold the last copies.
//!
//! The episode is over as soon as a cycle gets past the fetch: hcfs builds a
//! plan only after the listing was accepted, so the plan-ready callback (and,
//! redundantly, `SyncCompleted`) ends it, whether the files came back or the
//! confirmation was applied.
//!
//! ## What this state adds
//!
//! - **Change-only emits.** The prompt needs the drive once, and again only
//!   when its count changes; the per-retry repeats are absorbed here
//!   ([`Recorded::Unchanged`]). Whether this account may confirm is resolved
//!   off the bridge's thread (it reads the database), so a report is recorded
//!   first and published by [`EmptyRemoteState::publish`].
//! - **One notification per episode.** The first publish of an episode
//!   claims it. A pause hides the prompt ([`EmptyRemoteState::hide`]) without
//!   ending the episode, so a resume into the same empty listing does not
//!   notify again; success, drive removal and logout end it. The state is
//!   in memory only, since hcfs keeps no record of the refusal: a relaunch
//!   while the listing is still empty starts a new episode and notifies
//!   once more.
//! - **An answer that did not take.** A confirmation is a marker that can
//!   expire unused, or that hcfs refuses at cycle time. When the first cycle
//!   that started after the answer reports the empty listing again, the
//!   prompt is shown again ([`EmptyRemoteState::note_answered`]).
//!
//! ## Concurrency
//!
//! One `std::sync::Mutex` locked for a single map operation per call; none
//! is async, so no guard crosses an `.await`. `publish` and `end` call their
//! `emit` under the lock on purpose: a drive's prompt is never shown after
//! the clear that ended it.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use crate::sync::mass_delete_hold::group_thousands;

/// What the user's machine is called in copy, matching the large-delete
/// prompt.
const THIS_DEVICE: &str = if cfg!(target_os = "macos") { "this Mac" } else { "this computer" };

/// One drive's refused empty listing, as the prompt shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmptyRemoteEntry {
    /// How many synced files this device still has for the drive.
    pub synced_count: usize,
    /// Whether this account may confirm the drive is empty (owners only).
    pub can_confirm: bool,
}

/// What recording a report changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    /// The same report as last cycle, already shown: nothing to emit.
    Unchanged,
    /// New, changed, not yet shown, or an answer that did not take: resolve
    /// whether this account may confirm and [`EmptyRemoteState::publish`] it.
    Publish,
}

/// Where an answer stands, from the prompt's point of view.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum AnswerCheck {
    /// No answer waiting to be checked.
    #[default]
    Idle,
    /// Answered; no cycle has started since.
    Answered,
    /// A cycle started after the answer: if it reports the empty listing
    /// again, the answer was not applied.
    Due,
}

/// One drive's bookkeeping.
#[derive(Debug, Default)]
struct Slot {
    /// The last reported baseline size.
    synced_count: usize,
    /// Set by the last publish; `None` until the first one.
    can_confirm: Option<bool>,
    /// Whether the latest report has been shown.
    shown: bool,
    /// Whether an answer is waiting to be checked.
    answer: AnswerCheck,
}

#[derive(Debug, Default)]
struct Inner {
    /// Drives whose listing is currently refused.
    slots: HashMap<String, Slot>,
    /// Drives whose episode has already notified.
    notified: HashSet<String>,
}

/// Every drive whose empty server listing hcfs is refusing. Keyed by drive
/// label; cleared on account reset, since a new account reuses labels.
#[derive(Debug, Default)]
pub struct EmptyRemoteState {
    inner: Mutex<Inner>,
}

impl EmptyRemoteState {
    /// An empty state.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // No method can panic while holding the lock, so a poisoned guard
        // still holds consistent state.
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Record one `SuspiciousEmptyRemote` report for `label`.
    pub fn record(&self, label: &str, synced_count: usize) -> Recorded {
        let mut inner = self.lock();
        let slot = inner.slots.entry(label.to_string()).or_default();

        let retried_answer = slot.answer == AnswerCheck::Due;
        if retried_answer {
            slot.answer = AnswerCheck::Idle;
        }
        if slot.shown && slot.synced_count == synced_count && !retried_answer {
            return Recorded::Unchanged;
        }

        slot.synced_count = synced_count;
        slot.shown = false;
        Recorded::Publish
    }

    /// Show `label`'s refused listing with whether this account may confirm
    /// it, calling `emit` under the lock. Returns whether this publish
    /// claimed the episode's notification.
    ///
    /// Does nothing (and returns `false`) when the episode ended while
    /// `can_confirm` was being resolved.
    pub fn publish(&self, label: &str, can_confirm: bool, emit: impl FnOnce(EmptyRemoteEntry)) -> bool {
        let mut inner = self.lock();
        let Some(slot) = inner.slots.get_mut(label) else {
            return false;
        };

        slot.can_confirm = Some(can_confirm);
        slot.shown = true;
        emit(EmptyRemoteEntry {
            synced_count: slot.synced_count,
            can_confirm,
        });
        inner.notified.insert(label.to_string())
    }

    /// The user confirmed the drive is empty; the confirmation is checked
    /// against the first cycle that starts after it ([`Self::begin_cycle`]).
    pub fn note_answered(&self, label: &str) {
        if let Some(slot) = self.lock().slots.get_mut(label) {
            slot.answer = AnswerCheck::Answered;
        }
    }

    /// A cycle started for `label`. hcfs reads the confirmation once, at the
    /// start of a cycle, so a report from this cycle on means the answer was
    /// not applied.
    pub fn begin_cycle(&self, label: &str) {
        if let Some(slot) = self.lock().slots.get_mut(label)
            && slot.answer == AnswerCheck::Answered
        {
            slot.answer = AnswerCheck::Due;
        }
    }

    /// The drive's prompt, when it has been published.
    #[must_use]
    pub fn entry(&self, label: &str) -> Option<EmptyRemoteEntry> {
        let inner = self.lock();
        let slot = inner.slots.get(label)?;
        Some(EmptyRemoteEntry {
            synced_count: slot.synced_count,
            can_confirm: slot.can_confirm?,
        })
    }

    /// Every published prompt, for hydration, sorted by label.
    #[must_use]
    pub fn all(&self) -> Vec<(String, EmptyRemoteEntry)> {
        let inner = self.lock();
        let mut all: Vec<_> = inner
            .slots
            .iter()
            .filter_map(|(label, slot)| {
                let can_confirm = slot.can_confirm?;
                let entry = EmptyRemoteEntry {
                    synced_count: slot.synced_count,
                    can_confirm,
                };
                Some((label.clone(), entry))
            })
            .collect();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        all
    }

    /// The drive stopped syncing (paused, or torn down for a re-init): take
    /// its prompt down, since no cycle runs to act on an answer, but keep
    /// the episode, so the same refusal after a resume does not notify
    /// again. Calls `emit` under the lock when a prompt was up.
    pub fn hide(&self, label: &str, emit: impl FnOnce()) {
        let mut inner = self.lock();
        if inner.slots.remove(label).is_some_and(|slot| slot.can_confirm.is_some()) {
            emit();
        }
    }

    /// The episode is over for `label`: a cycle got past the fetch, or the
    /// drive was removed. Calls `emit` under the lock when a prompt was up.
    pub fn end(&self, label: &str, emit: impl FnOnce()) {
        let mut inner = self.lock();
        inner.notified.remove(label);
        if inner.slots.remove(label).is_some_and(|slot| slot.can_confirm.is_some()) {
            emit();
        }
    }

    /// Forget every drive (logout, account reset).
    pub fn clear_all(&self) {
        let mut inner = self.lock();
        inner.slots.clear();
        inner.notified.clear();
    }
}

/// The prompt's words, as both the banner and the notification show them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmptyRemoteText {
    /// One line naming the drive.
    pub title: String,
    /// What has (not) happened, and what the user can do.
    pub body: Vec<String>,
}

/// "1 file" / "1,234 files".
fn files(n: usize) -> String {
    let noun = if n == 1 { "file" } else { "files" };
    format!("{} {noun}", group_thousands(n))
}

/// The words for a refused empty listing. Rust owns them so the member
/// explanation cannot drift from the state that decides who may confirm.
#[must_use]
pub fn empty_remote_text(label: &str, entry: EmptyRemoteEntry) -> EmptyRemoteText {
    let kept = format!(
        "{} still has {} from it. Nothing has been deleted, and this drive does not sync until this is resolved.",
        capitalized_device(),
        files(entry.synced_count)
    );
    let next = if entry.can_confirm {
        "If you emptied this drive on purpose, you can remove the files here too.".to_string()
    } else {
        "This is a shared drive. If its owner emptied or deleted it, your copies may be the only ones left, \
         so they are kept. Remove the drive to stop syncing it."
            .to_string()
    };
    EmptyRemoteText {
        title: format!("Hippius has no files in “{label}”"),
        body: vec![kept, next],
    }
}

/// The persisted notification's text: the banner's words, then what to do.
#[must_use]
pub fn empty_remote_notification_text(label: &str, entry: EmptyRemoteEntry) -> String {
    let text = empty_remote_text(label, entry);
    format!("{}. {} Open Hippius to review it.", text.title, text.body.join(" "))
}

/// [`THIS_DEVICE`] at the start of a sentence.
fn capitalized_device() -> String {
    let mut chars = THIS_DEVICE.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const L: &str = "photos";

    /// Record and publish one report, returning whether it notified.
    fn report(state: &EmptyRemoteState, count: usize, can_confirm: bool) -> Option<bool> {
        match state.record(L, count) {
            Recorded::Unchanged => None,
            Recorded::Publish => Some(state.publish(L, can_confirm, |_| {})),
        }
    }

    #[test]
    fn the_first_report_publishes_and_notifies_and_repeats_are_absorbed() {
        let state = EmptyRemoteState::new();

        assert_eq!(report(&state, 12, true), Some(true));
        assert_eq!(report(&state, 12, true), None, "a per-retry repeat emits nothing");
        assert_eq!(
            state.entry(L),
            Some(EmptyRemoteEntry {
                synced_count: 12,
                can_confirm: true
            })
        );
    }

    #[test]
    fn a_changed_count_is_shown_again_without_a_second_notification() {
        let state = EmptyRemoteState::new();
        report(&state, 12, true);

        let mut shown = None;
        assert_eq!(state.record(L, 15), Recorded::Publish);
        let notified = state.publish(L, true, |entry| shown = Some(entry));

        assert!(!notified, "one notification per episode");
        assert_eq!(shown.map(|e| e.synced_count), Some(15));
    }

    #[test]
    fn an_ended_episode_notifies_again_next_time() {
        let state = EmptyRemoteState::new();
        report(&state, 12, true);

        let mut cleared = false;
        state.end(L, || cleared = true);

        assert!(cleared, "the prompt is taken down");
        assert_eq!(state.entry(L), None);
        assert_eq!(report(&state, 12, true), Some(true), "a new episode");
    }

    #[test]
    fn a_hidden_drive_shows_again_on_resume_without_notifying() {
        let state = EmptyRemoteState::new();
        report(&state, 12, true);

        let mut cleared = false;
        state.hide(L, || cleared = true);
        assert!(cleared);
        assert!(state.all().is_empty());

        assert_eq!(report(&state, 12, true), Some(false), "shown again, not notified again");
    }

    #[test]
    fn a_publish_after_the_episode_ended_shows_nothing() {
        let state = EmptyRemoteState::new();
        assert_eq!(state.record(L, 12), Recorded::Publish);
        state.end(L, || panic!("nothing was shown yet, so nothing to clear"));

        let mut shown = false;
        let notified = state.publish(L, true, |_| shown = true);

        assert!(!shown && !notified, "a cleared drive must not be shown again");
    }

    #[test]
    fn an_unpublished_report_is_not_hydrated() {
        // Whether this account may confirm is not known yet.
        let state = EmptyRemoteState::new();
        state.record(L, 12);

        assert!(state.all().is_empty());
        assert_eq!(state.entry(L), None);
    }

    #[test]
    fn a_confirmation_that_did_not_take_is_shown_again() {
        let state = EmptyRemoteState::new();
        report(&state, 12, true);
        state.note_answered(L);

        // A report from a cycle that was already running when the user
        // answered says nothing about the answer.
        assert_eq!(state.record(L, 12), Recorded::Unchanged);

        state.begin_cycle(L);
        assert_eq!(state.record(L, 12), Recorded::Publish, "the next cycle refused it again");
        assert!(!state.publish(L, true, |_| {}));

        state.begin_cycle(L);
        assert_eq!(state.record(L, 12), Recorded::Unchanged, "re-shown once, not every cycle");
    }

    #[test]
    fn clear_all_forgets_every_drive_and_episode() {
        let state = EmptyRemoteState::new();
        report(&state, 12, true);

        state.clear_all();

        assert!(state.all().is_empty());
        assert_eq!(report(&state, 12, true), Some(true), "a new account notifies");
    }

    #[test]
    fn an_owner_is_offered_the_removal_and_a_member_is_told_why_not() {
        let owner = empty_remote_text(
            L,
            EmptyRemoteEntry {
                synced_count: 1_234,
                can_confirm: true,
            },
        );
        assert_eq!(owner.title, "Hippius has no files in “photos”");
        assert!(owner.body[0].contains("still has 1,234 files"), "{:?}", owner.body);
        assert!(owner.body[0].contains("Nothing has been deleted"));
        assert!(owner.body[1].contains("remove the files here too"));

        let member = empty_remote_text(
            L,
            EmptyRemoteEntry {
                synced_count: 1,
                can_confirm: false,
            },
        );
        assert!(member.body[0].contains("still has 1 file "), "{:?}", member.body);
        assert!(member.body[1].contains("shared drive"));
        assert!(!member.body[1].contains("remove the files here"), "no confirm for a member");
    }
}
