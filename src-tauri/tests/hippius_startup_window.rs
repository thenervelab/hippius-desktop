//! Regression pin for the startup window-reveal ordering.
//!
//! Audit 2026-06-05 finding B3: `setup` showed the main window synchronously,
//! before the spawned task installed the DB pool, so the webview booted and
//! fired its first IPC calls against a pool-less `AppState` and got transient
//! `PoolClosed` errors. The fix defers the reveal into the init task, after the
//! pool is installed and the schema ensured.
//!
//! # Why a static (source-level) pin
//!
//! `setup` is the Tauri setup closure — it needs a running app + event loop and
//! a real DB to exercise, which the project's no-`tauri::test` testing policy
//! (`src-tauri/CLAUDE.md`, axiom 111) deliberately avoids. What a regression
//! would silently reintroduce is a synchronous `win.show()` ahead of `set_pool`;
//! this test pins exactly that ordering by inspecting the setup function source,
//! mirroring the `hippius_relative_path_backfill.rs` / `hippius_conflict_resolution.rs`
//! static-pin convention.

const MAIN_RS: &str = include_str!("../src/main.rs");

#[test]
fn main_window_is_revealed_in_the_db_init_task_not_synchronously() {
    let setup = MAIN_RS.split("pub fn setup").nth(1).expect("setup fn present in main.rs");
    let spawn = setup.find("async_runtime::spawn").expect("setup spawns the db-init task");

    // The synchronous part of setup (everything before the init task is
    // spawned) must NOT reveal the window — that is the exact early-show the
    // PoolClosed race needed.
    let sync_prefix = &setup[..spawn];
    assert!(
        !sync_prefix.contains(".show()"),
        "the main window must not be shown in the synchronous part of setup, before the DB pool \
         is installed in the spawned task (audit finding B3)"
    );

    // The deferred reveal must live in the init task, alongside the pool install.
    let task = &setup[spawn..];
    assert!(task.contains("set_pool"), "the db-init task installs the pool");
    assert!(
        task.contains("show_main"),
        "the deferred window reveal (show_main) must live in the db-init task so it runs after \
         the pool+schema are ready (audit finding B3)"
    );
}
