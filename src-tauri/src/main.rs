// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Hippius Desktop — Tauri 2.0 backend entry point.
//!
//! This binary is the sole entry point for the desktop app. It initializes
//! the Tauri runtime, registers all IPC commands, sets up the SQLite database,
//! and starts platform-specific services (deep links).
//!
//! **Note**: `lib.rs` in this crate is a vestigial template file — this `main.rs`
//! is the actual application entry point.

mod api;
mod app_state;
pub mod auth;
pub mod billing;
pub mod blockchain;
pub mod console_access;
pub mod crypto;
pub mod error;
#[cfg(any(unix, windows))]
pub mod finder_bridge;
pub mod infra;
pub mod media_preview;
pub mod notifications;
pub mod power;
pub mod recovery;
pub mod recovery_binding;
mod recovery_proof;
pub mod release_channel;
pub mod shared_drives;
pub mod shares;
pub mod splash;
pub mod sync;
#[cfg(test)]
mod test_helpers;
pub mod tray;
pub mod updates;
mod utils;
pub mod vpn;
pub mod wallet;

use crate::auth::contacts::{add_contact, delete_contact, get_contacts, update_contact};
use crate::auth::login::{login_with_mnemonic, validate_mnemonic};
use crate::auth::logout::logout_full;
use crate::auth::oauth::{complete_oauth_flow, parse_oauth_deep_link, start_oauth_flow};
use crate::auth::session_restore::{is_token_valid, restore_session};
use crate::auth::ssh_keys::{create_ssh_key, delete_ssh_key, list_ssh_keys};
use crate::billing::charts::{
    calculate_storage_capacity, calculate_storage_cost, format_balance_chart, format_credits_chart, transform_marketplace_credits,
};
use crate::billing::credit_balance::get_credit_balance_chart;
use crate::billing::credits::{check_sync_eligibility, get_user_credits};
use crate::billing::drive_credits::{get_drive_credits_chart, get_drive_credits_total};
use crate::billing::drive_storage::get_drive_storage_chart;
use crate::billing::eligibility::check_action_eligibility;
use crate::billing::queries::{
    get_add_credit_events, get_balance_transfers, get_billing_transactions, get_deposit_address, get_drive_storage_stats, get_marketplace_credits,
    get_system_balance,
};
use crate::billing::storage_overview::get_storage_overview;
use crate::billing::subscriptions::{create_subscription, get_customer_portal_url, get_subscription_data};
use crate::blockchain::bridge::deposit::bridge_alpha_to_halpha;
use crate::blockchain::bridge::explorer::bridge_fetch_onchain_data;
use crate::blockchain::bridge::history::bridge_list_transactions;
use crate::blockchain::bridge::queries::{bridge_estimate_fees, bridge_get_balances, bridge_get_staked_hotkeys, bridge_min_transfers};
use crate::blockchain::bridge::withdraw::bridge_halpha_to_alpha;
use crate::blockchain::convert::{planck_to_hip_full, to_plancks};
use crate::blockchain::queries::{
    generate_referral_link, get_account_balance, get_block_timestamp, get_referral_links, get_staking_info, validate_address,
};
use crate::blockchain::runtime::{get_wss_endpoint, test_rpc_endpoint_command, update_wss_endpoint_command};
use crate::blockchain::staking::{stake_bond, stake_claim_rewards, stake_unbond, stake_withdraw_unbonded};
use crate::blockchain::subscription::{start_block_subscription, stop_block_subscription};
use crate::blockchain::transfers::{compute_available_to_bond, compute_max_transferable};
use crate::blockchain::transfers::{transfer_balance, validate_send_balance};
use crate::console_access::validate_recovery_password;
use crate::infra::vm::{
    create_vm, get_vm_instance, list_vm_applications, list_vm_flavors, list_vm_images, list_vm_instances, reboot_vm, start_vm, stop_vm, terminate_vm,
};
use crate::media_preview::prepare_motion_photo_preview;
use crate::notifications::credits::{
    check_low_credit_notification, check_low_credit_notification_live, create_credit_notifications, create_sync_notification,
    get_is_above_half_credit, is_first_time, mark_first_time_seen, process_credit_events, update_is_above_half_credit,
};
use crate::notifications::crud::{
    add_notification, clear_all_notifications, credit_already_notified, delete_all_notifications, delete_notification,
    delete_system_notification_by_version, get_last_deleted_low_credit_time, get_local_enabled_notification_types,
    get_local_notification_preferences, get_unread_count, has_active_low_credit_notification, hippius_version_notification_exists,
    list_notifications, low_credit_subtype_exists, mark_all_notifications_read, mark_notification_read, mark_notification_unread,
    update_local_notification_preferences,
};
use crate::notifications::settings::{get_notification_settings, update_notification_settings};
use crate::recovery::{
    change_recovery_password, check_recovery_state, has_pending_rotation, mark_recovery_skipped, recover_mnemonic, reset_unlock_password,
    restore_with_mnemonic, resume_recovery_password_rotation, seal_and_upload_mnemonic,
};
use crate::recovery_binding::{cancel_account_recovery, list_recoverable_accounts, recover_account_files};
use crate::sync::control::{reveal_drive_in_finder, trigger_sync_now};
use crate::sync::device::{get_device_name, set_device_name};
use crate::sync::files::{
    add_file, add_files, add_folder, allow_asset_scope, delete_files, export_file, export_folder_zip, filter_file_entries, get_recent_files,
    get_user_files, list_sync_folder, list_sync_folder_grouped, rename_entry, resolve_file_info, resolve_file_path, search_user_files_recursive,
};
use crate::sync::folders::{delete_remote_folder, get_sync_folders_with_stats, list_remote_folders, restore_remote_folders};
use crate::sync::lifecycle::{
    add_local_sync_folder, auto_init_sync, change_sync_folder, initialize_sync, pause_drive, remove_drive, resume_drive, setup_and_init_sync,
    stop_sync,
};
use crate::sync::mnemonic::{ensure_sync_mnemonic, get_drive_mnemonic};
use crate::sync::paths::{get_sync_path, remove_sync_path, set_sync_path};
use crate::sync::progress::{sp_clear_all_data, sp_dismiss_sync_widget, sp_get_snapshot};
use crate::sync::recent_uploads::{get_recent_uploads, search_files};
use crate::sync::remote::{cache_remote_file, download_remote_file, get_thumbnail, list_remote_folder_files};
use crate::sync::status::{app_close, get_all_drive_statuses, get_sync_activity_rows, get_sync_engine_health};
use crate::tray::panel::{hide_tray_panel, toggle_tray_panel};
use crate::updates::{check_for_update, current_release_channel, install_update};
use crate::utils::app_location::is_app_translocated;
use crate::utils::logs::attach_logs_to_ticket;
use crate::utils::platform_info::get_platform_info;
use crate::utils::preferences::{get_user_preference, is_onboarding_done, save_user_preference, set_onboarding_done};
use crate::utils::support::{
    create_support_ticket, get_support_ticket_messages, list_support_tickets, post_ticket_message, update_support_ticket, upload_ticket_attachment,
};
use crate::utils::tray_menu::get_tray_menu_data;
use crate::vpn::commands::{vpn_close_vm_connection, vpn_connect, vpn_disconnect, vpn_list_connections, vpn_open_vm_connection, vpn_status};
use crate::wallet::commands::{
    local_wallet_create, local_wallet_delete, local_wallet_derive_address, local_wallet_export_backup, local_wallet_export_backup_zip,
    local_wallet_generate_mnemonic, local_wallet_get_active, local_wallet_get_decrypted_mnemonic, local_wallet_get_public_key, local_wallet_has_any,
    local_wallet_import_encrypted_backup, local_wallet_import_encrypted_backup_from_zip, local_wallet_list, local_wallet_rename,
    local_wallet_set_active, local_wallet_validate_mnemonic, local_wallet_verify_password,
};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous};
use tauri::{Builder, Emitter, Manager, Wry, path::BaseDirectory};
#[cfg(target_os = "linux")]
use tauri_plugin_deep_link::DeepLinkExt;
use tracing::{debug, error, info, warn};

/// Load environment variables from `.env` file(s). Tries both the working
/// directory and the `CARGO_MANIFEST_DIR` path (for development builds).
fn load_env() {
    let _ = dotenvy::dotenv();
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let env_path = format!("{manifest_dir}/.env");
    let _ = dotenvy::from_filename(env_path);
}

/// Initializes tracing with a stdout layer plus a daily rolling-file layer
/// under `$HOME/.hippius/logs/` (files named `hippius.YYYY-MM-DD.log`).
///
/// Returns `Some(WorkerGuard)` when the rolling-file writer is enabled, or
/// `None` when file logging was skipped (see below). When present, the caller
/// MUST hold the guard for the whole process lifetime: dropping it flushes the
/// background writer thread and then stops it, so any log emitted afterwards
/// is silently lost. Binding it to a `main`-scoped local is the crate's
/// documented idiom and keeps it alive exactly as long as the app runs.
///
/// File logging is best-effort — if the home directory can't be resolved or
/// the appender can't be created, the file layer is skipped and logging falls
/// back to stdout-only rather than aborting startup. `Option<Layer>` is a
/// no-op `Layer` when `None`, so the registry wiring is identical either way.
///
/// Retention: `max_log_files(7)` prunes on the rotation/write path, not at
/// startup (a known tracing-appender limitation), so a long-idle install may
/// briefly keep more than seven files until the next write. The log-bundling
/// step caps the number and size of files it ships independently, so this is
/// harmless here.
///
/// [`WorkerGuard`]: tracing_appender::non_blocking::WorkerGuard
fn init_logging() -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::{EnvFilter, fmt, prelude::*};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn,hcfs_client=info,Hippius=info"));
    let stdout_layer = fmt::layer().with_target(true).with_file(false).with_line_number(false);

    let (file_layer, guard) = match dirs::home_dir() {
        Some(home) => {
            let log_dir = home.join(".hippius").join("logs");
            match tracing_appender::rolling::RollingFileAppender::builder()
                .rotation(tracing_appender::rolling::Rotation::DAILY)
                .filename_prefix("hippius")
                .filename_suffix("log")
                .max_log_files(7)
                .build(&log_dir)
            {
                Ok(appender) => {
                    let (non_blocking, guard) = tracing_appender::non_blocking(appender);
                    // `with_ansi(false)`: files are read as plain text (and shipped to
                    // support), so colour escape codes would be noise.
                    let layer = fmt::layer().with_ansi(false).with_target(true).with_writer(non_blocking);
                    (Some(layer), Some(guard))
                }
                // Tracing isn't initialized yet and `print_stderr` is denied, so the
                // setup error can't be surfaced here; degrade quietly to stdout-only.
                Err(_) => (None, None),
            }
        }
        None => (None, None),
    };

    tracing_subscriber::registry().with(filter).with(stdout_layer).with(file_layer).init();

    guard
}

#[expect(clippy::too_many_lines, reason = "Tauri builder chain: handler registration must stay together")]
fn main() {
    // Shell-extension "Share" click, forwarded as a CLI invocation: talk to the
    // running app over the bridge socket and exit BEFORE booting the UI. The
    // Linux file-manager action files invoke `hippius --finder-share <abs-path>`.
    // This is the same binary in a short-lived second mode (the one-binary
    // requirement — no separate helper ships).
    #[cfg(unix)]
    {
        let args: Vec<String> = std::env::args().collect();
        if let Some(pos) = args.iter().position(|a| a == "--finder-share") {
            let Some(path) = args.get(pos + 1) else {
                use std::io::Write;
                let _ = writeln!(std::io::stderr(), "hippius: --finder-share requires a path argument");
                std::process::exit(2);
            };
            crate::finder_bridge::cli::run(path); // never returns
        }
    }

    load_env();

    // Initialize tracing (stdout + daily rolling file under ~/.hippius/logs/).
    // The guard must outlive the app so the non-blocking file writer keeps
    // flushing — see `init_logging`. Holding it in this `main` local does that.
    let _log_guard = init_logging();

    info!("Application starting...");
    info!("Tracing subscriber initialized - hcfs-client logs now visible");

    let builder = Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            info!("Another instance attempted to start with argv: {:?}", argv);
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.unminimize() {
                    debug!("Failed to unminimize window: {e}");
                }
                if let Err(e) = window.show() {
                    debug!("Failed to show window: {e}");
                }
                if let Err(e) = window.set_focus() {
                    debug!("Failed to set window focus: {e}");
                }
            }
            // On macOS, a URL-forwarder helper sends deep link URLs
            // via the single-instance socket as argv entries.
            // Detect and re-emit them so the frontend deep-link
            // handler picks them up.
            for arg in &argv {
                if arg.starts_with("hippiusapp://") {
                    // Log only the scheme+path: a direct-grant OAuth callback
                    // carries the bearer token in the query string, and the
                    // full URL used to land in the on-disk log (audit S-1).
                    info!("Deep link URL detected: {}", crate::auth::oauth::deep_link_public_part(arg));
                    let _ = app.emit("deep-link://new-url", vec![arg]);
                    break;
                }
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            // Sync control (hcfs-client)
            initialize_sync,
            add_local_sync_folder,
            setup_and_init_sync,
            stop_sync,
            remove_drive,
            pause_drive,
            resume_drive,
            trigger_sync_now,
            reveal_drive_in_finder,
            change_sync_folder,
            auto_init_sync,
            get_sync_folders_with_stats,
            // Sync status
            get_sync_activity_rows,
            get_sync_engine_health,
            get_all_drive_statuses,
            // File operations
            add_file,
            add_files,
            add_folder,
            delete_files,
            rename_entry,
            list_sync_folder,
            list_sync_folder_grouped,
            get_recent_files,
            get_recent_uploads,
            search_files,
            get_user_files,
            filter_file_entries,
            search_user_files_recursive,
            export_file,
            export_folder_zip,
            resolve_file_path,
            resolve_file_info,
            allow_asset_scope,
            // App lifecycle
            app_close,
            // Substrate / blockchain
            get_sync_path,
            set_sync_path,
            remove_sync_path,
            get_wss_endpoint,
            update_wss_endpoint_command,
            test_rpc_endpoint_command,
            // Splash terminal handshake — no-op the splash UI awaits
            // before dismissing itself.
            crate::splash::finish_splash,
            // HCFS mnemonic management
            get_drive_mnemonic,
            ensure_sync_mnemonic,
            // Billing auth (Ethereum challenge-response)
            crate::auth::billing_auth::ensure_billing_auth,
            // HCFS config commands
            crate::sync::config::save_hcfs_config,
            crate::sync::config::get_hcfs_config,
            // Selective sync (exclusion patterns)
            crate::sync::selective::list_exclude_patterns,
            crate::sync::selective::add_exclude_pattern,
            crate::sync::selective::remove_exclude_pattern,
            crate::sync::selective::apply_sync_selection,
            // Failure resolution (skip / exclude / retry)
            crate::sync::failure_commands::sp_skip_file,
            crate::sync::failure_commands::sp_exclude_file,
            crate::sync::failure_commands::sp_retry_file,
            crate::sync::failure_commands::get_drive_failures,
            crate::sync::failure_commands::retry_file_failure,
            crate::sync::failure_commands::retry_all_failures,
            // Stage & conflict resolution
            crate::sync::control::stage_changes,
            crate::sync::control::sync_with_conflict_resolutions,
            crate::sync::control::cancel_review,
            // Encrypted backup
            crate::sync::mnemonic::create_encrypted_backup,
            // Remote folder discovery
            list_remote_folders,
            restore_remote_folders,
            delete_remote_folder,
            // Remote folder browsing & one-off download
            list_remote_folder_files,
            download_remote_file,
            cache_remote_file,
            get_thumbnail,
            prepare_motion_photo_preview,
            // File sharing (link-based public shares)
            crate::shares::commands::hcfs_create_share,
            crate::shares::commands::hcfs_create_folder_share,
            crate::shares::commands::hcfs_list_shares,
            crate::shares::commands::hcfs_revoke_share,
            crate::shares::commands::hcfs_update_share_expiry,
            crate::shares::commands::hcfs_list_folder_shares,
            crate::shares::commands::hcfs_revoke_folder_share,
            crate::shares::commands::hcfs_update_folder_share_expiry,
            crate::shares::commands::hcfs_generate_share_password,
            crate::shares::commands::hcfs_list_share_history,
            crate::shares::commands::hcfs_remove_share_history,
            crate::shares::commands::hcfs_clear_share_history,
            crate::shares::capabilities::hcfs_get_capabilities,
            // Shared drives (owner invites/members + member add/leave). No
            // revoke-invite IPC in v1 — see shared_drives::commands docs.
            crate::shared_drives::commands::create_drive_invite,
            crate::shared_drives::commands::list_drive_members,
            crate::shared_drives::commands::remove_drive_member,
            crate::shared_drives::commands::list_my_drive_memberships,
            crate::shared_drives::commands::leave_shared_drive,
            crate::shared_drives::commands::add_shared_drive,
            // Shell "Share with Hippius": confirm/cancel the in-app visibility
            // chooser. Registered on all desktop platforms (macOS/Linux socket +
            // Windows named-pipe bridge); gated to `any(unix, windows)` to match
            // the `finder_bridge` module so no other target references it.
            #[cfg(any(unix, windows))]
            crate::finder_bridge::commands::hcfs_finder_confirm_share,
            #[cfg(any(unix, windows))]
            crate::finder_bridge::commands::hcfs_finder_cancel_share,
            // Device settings
            get_device_name,
            set_device_name,
            // Migration
            crate::sync::migration::check_migration,
            crate::sync::migration::dismiss_migration,
            crate::sync::migration::get_default_migration_path,
            crate::sync::migration::complete_migration_transition,
            crate::sync::migration::start_migration_flow,
            crate::sync::migration::start_server_migration,
            crate::sync::migration::start_migration_polling,
            crate::sync::migration::stop_migration_polling,
            // Blockchain queries & transactions
            get_account_balance,
            get_staking_info,
            get_block_timestamp,
            stake_bond,
            stake_unbond,
            stake_withdraw_unbonded,
            stake_claim_rewards,
            transfer_balance,
            validate_address,
            validate_send_balance,
            get_referral_links,
            generate_referral_link,
            // Bridge (Alpha <-> hAlpha). ⚠️ The write paths are FUNDS-CRITICAL and
            // compile-verified only — smoke-test on a funded testnet wallet
            // before release (see bridge/DEPOSIT_PORT_NOTES.md).
            bridge_estimate_fees,
            bridge_min_transfers,
            bridge_get_balances,
            bridge_get_staked_hotkeys,
            bridge_list_transactions,
            bridge_fetch_onchain_data,
            bridge_halpha_to_alpha,
            bridge_alpha_to_halpha,
            to_plancks,
            planck_to_hip_full,
            compute_max_transferable,
            compute_available_to_bond,
            // Console access
            // Account recovery (OAuth-based)
            validate_recovery_password,
            check_recovery_state,
            recover_mnemonic,
            seal_and_upload_mnemonic,
            mark_recovery_skipped,
            change_recovery_password,
            restore_with_mnemonic,
            reset_unlock_password,
            resume_recovery_password_rotation,
            has_pending_rotation,
            list_recoverable_accounts,
            recover_account_files,
            cancel_account_recovery,
            // Block subscription
            start_block_subscription,
            stop_block_subscription,
            // VM management
            list_vm_flavors,
            list_vm_images,
            list_vm_applications,
            list_vm_instances,
            get_vm_instance,
            create_vm,
            reboot_vm,
            start_vm,
            stop_vm,
            terminate_vm,
            // VM-connection VPN (NetBird, app-scoped, opt-in)
            vpn_status,
            vpn_connect,
            vpn_disconnect,
            vpn_open_vm_connection,
            vpn_close_vm_connection,
            vpn_list_connections,
            // SSH keys
            list_ssh_keys,
            create_ssh_key,
            delete_ssh_key,
            // Billing & credits
            get_user_credits,
            check_sync_eligibility,
            check_action_eligibility,
            get_billing_transactions,
            get_subscription_data,
            create_subscription,
            get_customer_portal_url,
            get_marketplace_credits,
            get_system_balance,
            get_balance_transfers,
            get_add_credit_events,
            get_drive_storage_stats,
            get_storage_overview,
            get_drive_storage_chart,
            get_drive_credits_chart,
            get_credit_balance_chart,
            get_drive_credits_total,
            get_deposit_address,
            // Notifications
            get_notification_settings,
            update_notification_settings,
            // Support tickets
            list_support_tickets,
            get_support_ticket_messages,
            create_support_ticket,
            update_support_ticket,
            upload_ticket_attachment,
            attach_logs_to_ticket,
            post_ticket_message,
            // OAuth
            start_oauth_flow,
            complete_oauth_flow,
            parse_oauth_deep_link,
            // Authentication & crypto
            login_with_mnemonic,
            validate_mnemonic,
            // Session lifecycle (Rust-managed; frontend gets data via these high-level commands)
            restore_session,
            logout_full,
            is_token_valid,
            get_tray_menu_data,
            // Tray popover panel (replaces the native tray menu)
            toggle_tray_panel,
            check_for_update,
            install_update,
            current_release_channel,
            hide_tray_panel,
            get_platform_info,
            is_app_translocated,
            // Finder extension enablement. Registered on every platform (they
            // answer `unsupported` off macOS) so the frontend guard needs no
            // platform branch of its own.
            crate::finder_bridge::enablement::finder_extension_state,
            crate::finder_bridge::enablement::open_finder_extension_settings,
            crate::finder_bridge::enablement::enable_finder_extension,
            // Local DB (notifications, address book, onboarding, preferences, app state)
            add_notification,
            list_notifications,
            mark_notification_read,
            mark_notification_unread,
            mark_all_notifications_read,
            delete_notification,
            delete_all_notifications,
            delete_system_notification_by_version,
            get_unread_count,
            credit_already_notified,
            low_credit_subtype_exists,
            has_active_low_credit_notification,
            check_low_credit_notification,
            check_low_credit_notification_live,
            process_credit_events,
            create_credit_notifications,
            create_sync_notification,
            get_last_deleted_low_credit_time,
            hippius_version_notification_exists,
            clear_all_notifications,
            get_local_notification_preferences,
            update_local_notification_preferences,
            get_local_enabled_notification_types,
            is_first_time,
            mark_first_time_seen,
            get_is_above_half_credit,
            update_is_above_half_credit,
            add_contact,
            get_contacts,
            update_contact,
            delete_contact,
            // Local wallets (password-encrypted Substrate wallets)
            local_wallet_list,
            local_wallet_has_any,
            local_wallet_get_active,
            local_wallet_generate_mnemonic,
            local_wallet_validate_mnemonic,
            local_wallet_derive_address,
            local_wallet_create,
            local_wallet_set_active,
            local_wallet_rename,
            local_wallet_delete,
            local_wallet_verify_password,
            local_wallet_get_decrypted_mnemonic,
            local_wallet_get_public_key,
            local_wallet_export_backup,
            local_wallet_export_backup_zip,
            local_wallet_import_encrypted_backup,
            local_wallet_import_encrypted_backup_from_zip,
            is_onboarding_done,
            set_onboarding_done,
            get_user_preference,
            save_user_preference,
            // Sync progress (in-memory tracking)
            sp_clear_all_data,
            sp_get_snapshot,
            sp_dismiss_sync_widget,
            // Chart data formatting
            format_credits_chart,
            format_balance_chart,
            transform_marketplace_credits,
            calculate_storage_cost,
            calculate_storage_capacity,
        ]);

    let builder = setup(builder);
    let builder = on_window_event(builder);

    // E2E only: register the in-process WebDriver automation server so the
    // WebdriverIO smoke suite (`e2e/`) can drive a real macOS WKWebView build.
    // Gated behind the off-by-default `e2e-webdriver` feature — the server is
    // unauthenticated localhost automation and must never reach a release
    // artifact. Plugin registration order is irrelevant, so appending it here
    // (after `setup`/`on_window_event`) keeps the gate to a single line.
    #[cfg(feature = "e2e-webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    info!("Running Tauri application...");
    let app = builder.build(tauri::generate_context!()).expect("error while building tauri application");

    app.run(|app_handle, event| {
        // `app_handle` is consumed only by the macOS-gated `Reopen` arm below;
        // on other platforms borrow-and-discard it so the unused-binding lint
        // stays quiet without an `#[allow]`.
        #[cfg(not(target_os = "macos"))]
        let _ = &app_handle;
        match event {
            // macOS dock icon click with no visible windows. Mirrors the
            // tray's "Open Hippius" action.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                if has_visible_windows {
                    return;
                }
                if let Some(window) = app_handle.get_webview_window("main") {
                    if let Err(e) = window.unminimize() {
                        debug!("Failed to unminimize window on reopen: {e}");
                    }
                    if let Err(e) = window.show() {
                        debug!("Failed to show window on reopen: {e}");
                    }
                    if let Err(e) = window.set_focus() {
                        debug!("Failed to focus window on reopen: {e}");
                    }
                }
            }

            _ => {}
        }
    });
}

// ---------------------------------------------------------------------------
// App setup (was setup.rs)
// ---------------------------------------------------------------------------

/// Window-close dispatcher.
///
/// On macOS, closing the main window (red-X / Cmd+W) hides the window so
/// the app keeps running in the tray. All genuine quit paths on macOS —
/// Cmd+Q, the app menu's Quit Hippius, the tray's Quit Hippius — let
/// Tauri exit directly without app-level cleanup.
///
/// On Windows/Linux, closing the window exits the app via `app.exit(0)`.
pub fn on_window_event(builder: Builder<Wry>) -> Builder<Wry> {
    builder.on_window_event(|window, event| {
        // Click-outside dismissal for the tray popover: when the panel loses
        // focus, hide it. Centralized here (rather than in the FE) so the
        // re-open cooldown timestamp is recorded against the same `AppState`
        // that `toggle_tray_panel` reads.
        if let tauri::WindowEvent::Focused(false) = event
            && window.label() == crate::tray::panel::PANEL_LABEL
        {
            crate::tray::panel::on_panel_blur(window.app_handle());
        }

        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Only intercept the main window. If a future refactor adds a
            // secondary window (e.g. a settings popup), its close button
            // should behave normally and not hide-to-tray the whole app.
            if window.label() != "main" {
                return;
            }

            api.prevent_close();

            #[cfg(target_os = "macos")]
            {
                info!("Window close requested on macOS — hiding to tray");
                if let Err(e) = window.hide() {
                    warn!("Failed to hide window: {e}");
                }
            }

            #[cfg(not(target_os = "macos"))]
            {
                info!("Window close requested — exiting app");
                window.app_handle().exit(0);
            }
        }
    })
}

/// Open the application's SQLite pool with desktop-app-tuned PRAGMAs.
///
/// - **WAL** journal mode: readers don't block writers and vice-versa, which
///   matters because every IPC command goes through this pool.
/// - **`synchronous=NORMAL`**: at most one in-flight transaction is lost on
///   power loss, which is acceptable here — all persisted state is
///   re-derivable from server-of-record (HCFS, blockchain).
/// - **`busy_timeout=5s`**: rare contention waits at the driver level instead
///   of surfacing `SQLITE_BUSY` immediately to the IPC caller.
/// - **`foreign_keys=ON`**: enforce referential integrity (off by default in
///   SQLite for backwards compatibility).
/// - **`max_connections=8`**: the IPC fan-in is small; eight is plenty and
///   keeps fd usage tight.
async fn open_db_pool(db_path: &std::path::Path) -> Result<SqlitePool, sqlx::Error> {
    let connect_opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(std::time::Duration::from_secs(5))
        .foreign_keys(true)
        .pragma("cache_size", "-20000");

    let pool = SqlitePoolOptions::new().max_connections(8).connect_with(connect_opts).await?;

    // Restrict the DB and its WAL/SHM sidecars to owner-only (0600). The DB can
    // hold a plaintext bearer-token fallback (keychain-less hosts) and encrypted
    // drive-password ciphertext; under a default umask it would be created
    // world-readable, so a second local user on a shared host could read it
    // (audit R-17). Best-effort — a perms failure must never block launch.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for suffix in ["", "-wal", "-shm"] {
            let path = {
                let mut s = db_path.as_os_str().to_owned();
                s.push(suffix);
                std::path::PathBuf::from(s)
            };
            if path.exists()
                && let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            {
                tracing::warn!(path = %path.display(), error = %e, "failed to chmod 0600 on DB file");
            }
        }
    }

    Ok(pool)
}

/// Attach the Tauri `setup` hook to `builder` and return it for chaining.
///
/// The hook fires once at startup, before the window is shown: it loads the
/// bundled `.env` resource, registers deep links at runtime on Linux (required
/// for dev), constructs the single `AppState` (the app holds no statics), and
/// wires the sync bridge's app handle. Returning the builder lets this compose
/// in `main()`'s builder chain.
#[expect(
    clippy::too_many_lines,
    reason = "Linear one-shot startup pipeline — env load, dir hardening (R-17 chmod), deep links, AppState, migrations, tray. Splitting it fragments the strict ordering between the steps without reducing complexity."
)]
pub fn setup(builder: Builder<Wry>) -> Builder<Wry> {
    builder.setup(|app| {
        debug!(".setup() closure called in setup.rs");

        // macOS 26+ (Tahoe) mounts legacy transparent .icns icons onto a white
        // rounded tile in the Dock, but renders a RUNTIME-set application icon
        // as-is (the sticker-style glyph). Tauri performs this runtime set in
        // dev builds only (see tauri's RunEvent::Ready, cfg(all(dev, macos))),
        // which is why `pnpm tauri:dev` showed the bare hippo while installed
        // builds showed the white tile. Mirror the same call for release so
        // both modes look identical. Must run on the main thread (AppKit);
        // Tauri's setup hook does.
        #[cfg(all(not(dev), target_os = "macos"))]
        {
            use cocoa::appkit::{NSApp, NSApplication, NSImage};
            use cocoa::base::nil;
            use cocoa::foundation::NSData;

            // 512px transparent-background source; the Dock scales down.
            static DOCK_ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");
            // SAFETY: AppKit calls on the main thread (setup runs there).
            // NSData copies the byte buffer; NSImage may return nil on
            // malformed data, which we guard instead of unwrapping.
            unsafe {
                let data = NSData::dataWithBytes_length_(nil, DOCK_ICON_PNG.as_ptr().cast(), DOCK_ICON_PNG.len() as u64);
                let image = NSImage::initWithData_(NSImage::alloc(nil), data);
                if image == nil {
                    warn!("dock icon: NSImage init failed; keeping bundle icon");
                } else {
                    NSApp().setApplicationIconImage_(image);
                }
            }
        }

        // Gatekeeper App Translocation makes macOS forget folder permissions on
        // every launch (the "asks 10 times" symptom). Record it at startup so it
        // shows up in support-log bundles even when the UI never mounts; the
        // frontend separately queries `is_app_translocated` to surface a notice.
        #[cfg(target_os = "macos")]
        if crate::utils::app_location::current_exe_is_translocated() {
            warn!(
                "Hippius is running from a Gatekeeper App Translocation mount — macOS will not \
                 persist folder permissions across launches. The user should move Hippius into \
                 /Applications."
            );
        }

        // Reclaim upload-chunk staging directories abandoned by earlier runs.
        //
        // This is the launch trigger, and it must live here rather than only in
        // the sync-init funnel: `auto_init_sync` skips paused drives, so a user
        // whose disk filled and who reacted by pausing everything — or who
        // removed the drives outright — would otherwise reclaim nothing on the
        // very launch they need it. `initialize_sync_inner` keeps its own
        // `get_or_init` on the same `OnceCell`, which is what orders the pass
        // BEFORE any upload starts; whichever fires first runs it exactly once
        // and the other awaits that result. See `crate::sync::chunk_reclaim`.
        {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<crate::app_state::AppState>();
                state.chunk_reclaim.get_or_init(crate::sync::chunk_reclaim::reclaim_startup).await;
            });
        }

        if let Ok(env_path) = app.path().resolve(".env", BaseDirectory::Resource) {
            let _ = dotenvy::from_filename(env_path);
        }

        // Register deep links for Linux at runtime (required for dev)
        #[cfg(target_os = "linux")]
        {
            debug!("Registering deep links for Linux...");
            match app.deep_link().register_all() {
                Ok(()) => info!("Deep links registered successfully for Linux"),
                Err(e) => error!("Failed to register deep links: {}", e),
            }
        }

        let app_handle = app.handle().clone();

        // Single AppState holds all mutable state — zero statics.
        let app_state = crate::app_state::AppState::new();
        app_state.sync_bridge.set_app_handle(app_handle.clone());
        // Downgrade BEFORE `manage` consumes the AppState. The
        // watchdog holds a `Weak<UploadProcessingState>` so app
        // shutdown can drop the state without keeping it alive via
        // a long-lived background task. See `spawn_watchdog`.
        let upload_processing_weak = std::sync::Arc::downgrade(&app_state.upload_processing);
        // Same Weak-before-manage discipline for the preparing-override
        // watchdog: it self-clears a stuck "Preparing sync…" when
        // hcfs-client drops a terminal event (drive removed mid-cycle).
        // It needs the runner too, to force the snapshot re-emit that
        // pushes the cleared state to the FE.
        let preparing_weak = std::sync::Arc::downgrade(&app_state.preparing);
        let sync_weak = std::sync::Arc::downgrade(&app_state.sync);
        // Subscribe to VPN status transitions BEFORE `manage` consumes the
        // AppState; the bridge task (spawned just below) is the single emitter of
        // VPN_STATUS_CHANGED. See vpn::state / vpn::commands::spawn_status_bridge.
        let vpn_status_rx = app_state.vpn.subscribe();
        app_handle.manage(app_state);
        crate::sync::upload_processing::spawn_watchdog(upload_processing_weak, app_handle.clone());
        crate::sync::preparing::spawn_watchdog(preparing_weak, sync_weak);
        crate::vpn::commands::spawn_status_bridge(app_handle.clone(), vpn_status_rx);

        // Start the file-manager/Explorer extension bridge (boot-scoped) on every
        // desktop platform: the Unix-socket server on macOS/Linux, the named-pipe
        // server on Windows. Best-effort — a bind failure disables the integration
        // but never blocks launch.
        #[cfg(any(unix, windows))]
        crate::finder_bridge::lifecycle::start(&app_handle);

        // Pre-create the (hidden) tray popover so the first tray click shows it
        // instantly instead of paying webview + route load cost on click.
        crate::tray::panel::prewarm(&app_handle);

        let win = app.get_webview_window("main").expect("main window not found");

        // Open devtools on startup when `HIPPIUS_DEVTOOLS=1` is set in the
        // environment. Works in both debug and release builds because the
        // Tauri `devtools` feature is enabled in Cargo.toml. Use this to
        // inspect OAuth/recovery flows without rebuilding a debug DMG:
        //     HIPPIUS_DEVTOOLS=1 pnpm tauri:static -- --release
        if std::env::var("HIPPIUS_DEVTOOLS").as_deref() == Ok("1") {
            info!("HIPPIUS_DEVTOOLS=1 — opening devtools on main window");
            win.open_devtools();
        }

        if let Some(m) = win.current_monitor()? {
            let phys = m.size();
            let origin = m.position();

            let w = (phys.width as f64 * 0.8) as u32;
            let h = (phys.height as f64 * 0.9) as u32;

            let pos_x = origin.x + ((phys.width as i32 - w as i32) / 2);
            let pos_y = origin.y + ((phys.height as i32 - h as i32) / 2);

            win.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w, height: h }))?;
            win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: pos_x, y: pos_y }))?;
            // NOTE: the window is sized/positioned here but deliberately NOT
            // shown yet. Showing it synchronously would let the webview boot and
            // fire its first IPC calls before the async task below installs the
            // DB pool, racing those calls to a transient PoolClosed error. The
            // reveal is deferred into the init task and happens once the schema
            // is ready (or once init has definitively failed).
        }
        // Spawn async task for database initialization.
        tauri::async_runtime::spawn(async move {
            debug!("Async block started in setup.rs");

            // Reveal the (sized-but-hidden) main window. Deferred out of the
            // synchronous setup so it never appears before the pool+schema are
            // ready. Idempotent (Tauri `show` on an already-visible window is a
            // no-op), and called on EVERY exit path — including the fatal DB
            // failures below — so a broken database still surfaces a window the
            // FE can render its error state in, rather than an invisible,
            // seemingly-hung app.
            let show_main = || {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                }
            };

            // Database initialization. A failure here is fatal, but it must NOT
            // panic: a panic inside `tauri::async_runtime::spawn` is swallowed by
            // the runtime, so `set_pool` would never run and EVERY IPC command
            // would fail with PoolClosed for the whole session, with no error
            // shown. Handle both failure modes the way the open_db_pool branch
            // below already does — log FATAL, reveal the window, and return.
            let Some(home_dir) = dirs::home_dir() else {
                error!("FATAL: could not determine home directory; database not initialized");
                show_main();
                return;
            };
            let db_dir = home_dir.join(".hippius");
            let db_path = db_dir.join("hippius.db");
            debug!("DB path: {}", db_path.display());

            // create_dir_all is blocking std::fs — run it off the async executor.
            let db_dir_for_mkdir = db_dir.clone();
            match tokio::task::spawn_blocking(move || -> std::io::Result<()> {
                std::fs::create_dir_all(&db_dir_for_mkdir)?;
                // Owner-only (0700): ~/.hippius holds the encrypted master
                // mnemonic, the SQLite DB (with a plaintext token fallback on
                // keychain-less hosts), and logs. Tighten regardless of the
                // inherited umask so a second local user can't read them, and
                // re-tighten existing installs on launch (audit R-17).
                //
                // Warn-only, like the DB-file 0600 chmod in `open_db_pool`: a
                // missing directory is fatal (no dir ⇒ no DB), but a hardening
                // chmod that fails on a no-POSIX-perms $HOME (network/FAT
                // mounts) must not brick launch.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Err(e) = std::fs::set_permissions(&db_dir_for_mkdir, std::fs::Permissions::from_mode(0o700)) {
                        warn!(dir = %db_dir_for_mkdir.display(), error = %e, "failed to chmod 0700 on ~/.hippius (continuing)");
                    }
                }
                Ok(())
            })
            .await
            {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    error!("FATAL: failed to create {}: {e}", db_dir.display());
                    show_main();
                    return;
                }
                Err(e) => {
                    error!("FATAL: directory-creation task failed to join: {e}");
                    show_main();
                    return;
                }
            }

            // The DB file itself is created by `SqliteConnectOptions::create_if_missing(true)`
            // inside `open_db_pool`, so no explicit `File::create` is needed here.
            let pool = match open_db_pool(&db_path).await {
                Ok(pool) => pool,
                Err(e) => {
                    error!("FATAL: Failed to open database at {}: {e}", db_path.display());
                    show_main();
                    return; // cannot propagate from spawned task; error is logged
                }
            };
            app_handle.state::<crate::app_state::AppState>().set_pool(pool.clone());

            // Ensure all tables and columns exist
            if let Err(e) = crate::utils::schema::ensure_table_schema(&pool).await {
                error!("FATAL: Failed to ensure table schema: {}", e);
                show_main();
                return;
            }

            // Pool installed AND schema ensured — the backend can now service
            // IPC, so it is safe to reveal the window. Done before the
            // idempotent background migrations below so the user sees the app
            // the moment it is usable, not after the data fixups finish.
            show_main();

            // Migrate account keys from 8-char to 16-char format
            if let Err(e) = crate::utils::schema::migrate_account_keys(&pool).await {
                warn!("Account key migration failed (non-fatal): {}", e);
            }

            // Collapse the legacy global `sync_user_stopped` preference
            // into per-drive `sync_paths.is_paused`. Idempotent — runs
            // every launch and short-circuits when already migrated.
            // See `sync::user_stopped_migration` for details.
            crate::sync::user_stopped_migration::run_at_startup(&pool).await;

            // One-shot: clear the painted-paused state left behind by
            // `user_stopped_migration` for users who had the legacy
            // global "stopped" flag set transiently. Gated by a sentinel
            // preference so future user-initiated pauses still persist
            // normally. See `sync::user_stopped_reversal` for details.
            crate::sync::user_stopped_reversal::run_at_startup(&pool).await;

            // One-shot: clear `sync_paths.relative_paths_backfilled_at`
            // for drives that were marked "done" by the pre-NFC backfill
            // (which flipped the flag even when every non-NFC entry was
            // rejected server-side). After clearing, the next drive init
            // retries the backfill with NFC-normalised paths. Keyed by a
            // sentinel preference so it runs exactly once per install.
            // See `sync::relative_path_backfill_reset` for details.
            crate::sync::relative_path_backfill_reset::run_at_startup(&pool).await;

            // Collapse duplicate welcome notifications: a bare `"Welcome"`
            // subtype bypasses the `starts_with("Welcome-")` dedup guard, so
            // such rows can accumulate one per login. Keeps the oldest per
            // user so the timestamp used by `process_credit_events` for event
            // filtering stays valid. Idempotent — a one-time sweep that finds
            // nothing to delete on subsequent launches.
            if let Err(e) = crate::notifications::crud::cleanup_duplicate_welcome_notifications(&pool).await {
                warn!("Welcome notification cleanup failed (non-fatal): {}", e);
            }
            if let Err(e) = crate::notifications::crud::prune_deleted_notifications(&pool).await {
                warn!("Deleted-notification prune failed (non-fatal): {}", e);
            }

            info!("Database initialized successfully");
        });
        Ok(())
    })
}

#[cfg(all(test, unix))]
mod db_perms_tests {
    use super::open_db_pool;
    use std::os::unix::fs::PermissionsExt;

    /// R-17: a freshly-created DB file must be owner-only `0600`, not
    /// umask-dependent — it can hold a plaintext token fallback on
    /// keychain-less hosts.
    #[tokio::test]
    async fn open_db_pool_creates_0600_file() {
        let dir = tempfile::tempdir().expect("tmpdir");
        let db_path = dir.path().join("hippius.db");

        let _pool = open_db_pool(&db_path).await.expect("open pool");

        let mode = std::fs::metadata(&db_path).expect("stat db").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "DB file must be chmod 0600, got {mode:o}");

        // The WAL sidecar (created by WAL journal mode on connect) must also be
        // locked down — it can contain not-yet-checkpointed writes.
        let wal = dir.path().join("hippius.db-wal");
        if wal.exists() {
            let wal_mode = std::fs::metadata(&wal).unwrap().permissions().mode() & 0o777;
            assert_eq!(wal_mode, 0o600, "WAL sidecar must be chmod 0600, got {wal_mode:o}");
        }
    }
}
