//! Shared test-only helpers.
//!
//! Centralises process-global state that tests mutate (notably `$HOME`)
//! so cross-module tests don't race. `cargo test` runs test functions in
//! parallel threads within the same process; tests that override `$HOME`
//! to point into a per-test tempdir clobber each other without
//! serialisation.
//!
//! Tests that hold [`HOME_LOCK`] across `.await` points must apply
//! `#[allow(clippy::await_holding_lock)]` at the test function level.
//! The lint is a false positive here: `#[tokio::test]` uses a
//! current-thread runtime, so awaits don't yield to another task
//! contending for the same lock. The lock protects against *different
//! tests* running on different threads, not continuation points within
//! one test.

#![cfg(test)]

use std::sync::Mutex;

/// Mutex every test must acquire before calling
/// `std::env::set_var("HOME", ...)` (and for the duration of any code that
/// reads `$HOME` after the override). Prevents parallel tests from
/// seeing each other's tempdirs as their `$HOME`.
pub(crate) static HOME_LOCK: Mutex<()> = Mutex::new(());

/// Collects `tracing` output so a test can assert on what was logged.
/// Clones share one buffer; read it back with [`CaptureWriter::text`].
#[derive(Clone, Default)]
pub(crate) struct CaptureWriter(std::sync::Arc<Mutex<Vec<u8>>>);

impl CaptureWriter {
    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("capture buffer lock")).into_owned()
    }
}

impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("capture buffer lock").extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CaptureWriter {
    type Writer = Self;

    fn make_writer(&'a self) -> Self {
        self.clone()
    }
}

/// Serialises every test that installs a capture subscriber, so their
/// interactions with `tracing`'s process-global callsite state are ordered.
static CAPTURE_LOCK: Mutex<()> = Mutex::new(());

/// A plain-text `fmt` subscriber writing into a [`CaptureWriter`], for
/// asserting on what a code path logs. Install it with
/// `tracing::subscriber::with_default`, which is thread-local — parallel
/// tests don't see each other's captures. Hold the returned guard for the
/// test's duration.
///
/// The subscriber always records at TRACE; assert on the level *text* in
/// the captured output instead of passing a max level. This is
/// load-bearing: `tracing` caches per-callsite interest PROCESS-GLOBALLY
/// from whichever subscriber touches the callsite first, so a WARN-capped
/// capture touching a `debug!` callsite pinned it disabled for every later
/// test — an observed intermittent failure, ordering-dependent. A uniform
/// TRACE ceiling means no capture can poison a callsite for another.
pub(crate) fn capture_subscriber() -> (impl tracing::Subscriber + Send + Sync, CaptureWriter, std::sync::MutexGuard<'static, ()>) {
    // A failed assertion inside a capture test poisons the lock; the state
    // it protects is only "one capture subscriber at a time", so recovery
    // is always safe.
    let guard = CAPTURE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let writer = CaptureWriter::default();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(writer.clone())
        .finish();
    (subscriber, writer, guard)
}
