//! Shared test-only helpers.
//!
//! Centralises process-global state that tests mutate (notably `$HOME`)
//! so cross-module tests don't race. `cargo test` runs test functions in
//! parallel threads within the same process; tests that override `$HOME`
//! to point into a per-test tempdir clobber each other without
//! serialisation.
//!
//! Tests that hold [`HOME_LOCK`] across `.await` points must apply
//! `#[expect(clippy::await_holding_lock, reason = "...")]` at the test
//! function level.
//! The lint is a false positive here: `#[tokio::test]` uses a
//! current-thread runtime, so awaits don't yield to another task
//! contending for the same lock. The lock protects against *different
//! tests* running on different threads, not continuation points within
//! one test.

#![cfg(test)]

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// Serializes the unit tests that use `$HOME`. A test that overrides it
/// takes the lock through [`set_test_home`]; a test that only reads it
/// takes `HOME_LOCK` directly and holds the guard while it reads. Prevents
/// parallel tests from seeing each other's tempdirs as their `$HOME`.
pub(crate) static HOME_LOCK: Mutex<()> = Mutex::new(());

/// Lock [`HOME_LOCK`] and point `$HOME` at `home` until the returned guard
/// drops.
///
/// A poisoned lock is taken anyway: the only state it guards is `$HOME`,
/// which this call overwrites, so one panicking test does not fail every
/// later one.
#[must_use = "`$HOME` is only reserved while the guard lives"]
pub(crate) fn set_test_home(home: &Path) -> MutexGuard<'static, ()> {
    let guard = HOME_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    // SAFETY: not fully discharged, and accepted because this is test-only.
    // `set_var` requires that no other thread reads or writes the
    // environment during the call. What holds: std serializes its own env
    // reads and writes, so no Rust code sees a torn value. What is not ruled
    // out: C code on another test thread (SQLite, the system resolver)
    // calling `getenv` during this write. libtest offers no hook that runs
    // before its threads start, which is where this write would otherwise
    // belong.
    unsafe { std::env::set_var("HOME", home) };
    guard
}

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

/// Serialises every log-capturing test, so their interactions with the
/// process-global warn-throttle and log-routing state are ordered.
static CAPTURE_LOCK: Mutex<()> = Mutex::new(());

thread_local! {
    /// The calling thread's armed capture sink. Events from threads with no
    /// armed sink are discarded, which is what isolates parallel tests.
    static ACTIVE_SINK: std::cell::RefCell<Option<CaptureWriter>> = const { std::cell::RefCell::new(None) };
}

/// `MakeWriter` for the process-global test subscriber: routes each event
/// to the CALLING thread's armed sink.
struct RoutingWriter;

enum RoutedWriter {
    Sink(CaptureWriter),
    Discard,
}

impl std::io::Write for RoutedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let RoutedWriter::Sink(sink) = self {
            return sink.write(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for RoutingWriter {
    type Writer = RoutedWriter;

    fn make_writer(&'a self) -> RoutedWriter {
        ACTIVE_SINK
            .with(|sink| sink.borrow().clone())
            .map_or(RoutedWriter::Discard, RoutedWriter::Sink)
    }
}

/// Installs the process-global capture subscriber exactly once. GLOBAL is
/// load-bearing: `tracing` caches per-callsite interest process-wide, and
/// only a global-default registration rebuilds that cache — a thread-local
/// `with_default` does not, so a callsite first touched with no subscriber
/// (any other test serializing an error) stayed cached "never interested"
/// and its events silently vanished from later thread-local captures. Two
/// distinct intermittent single-test failures came from exactly that.
fn ensure_global_capture_subscriber() {
    static INSTALL: std::sync::Once = std::sync::Once::new();

    INSTALL.call_once(|| {
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(RoutingWriter)
            .finish();
        tracing::subscriber::set_global_default(subscriber).expect("no other global subscriber in the test binary");
    });
}

/// An armed log capture: everything the current thread logs until drop
/// lands in [`LogCapture::text`]. Holds the capture lock for its lifetime.
pub(crate) struct LogCapture {
    writer: CaptureWriter,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl LogCapture {
    pub(crate) fn text(&self) -> String {
        self.writer.text()
    }
}

impl Drop for LogCapture {
    fn drop(&mut self) {
        ACTIVE_SINK.with(|sink| *sink.borrow_mut() = None);
    }
}

/// Arms log capture for the current thread and returns the handle to read
/// it back. The subscriber always records at TRACE — assert on the level
/// TEXT ("WARN"/"DEBUG"/"ERROR") in the captured output.
pub(crate) fn capture_logs() -> LogCapture {
    ensure_global_capture_subscriber();

    // Poison recovery is safe: the lock only orders capture tests.
    let lock = CAPTURE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let writer = CaptureWriter::default();
    ACTIVE_SINK.with(|sink| *sink.borrow_mut() = Some(writer.clone()));

    LogCapture { writer, _lock: lock }
}

/// The bare capture lock, for tests that don't capture but DO serialize
/// warn-tier `AppError`s: serialization consumes the process-global warn
/// throttle's per-kind window, so such a test must not interleave with a
/// capture test's reset-then-serialize sequence. Do not combine with
/// [`capture_logs`] in one test — it acquires the same lock.
pub(crate) fn capture_lock() -> std::sync::MutexGuard<'static, ()> {
    CAPTURE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
