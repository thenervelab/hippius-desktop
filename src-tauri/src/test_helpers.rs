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
