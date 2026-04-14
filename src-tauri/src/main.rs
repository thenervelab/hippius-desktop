// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Hippius Desktop — Tauri 2.0 backend entry point.
//!
//! This binary is the sole entry point for the desktop app. It initializes
//! the Tauri runtime, registers all IPC commands, sets up the SQLite database,
//! and starts platform-specific services (Nebula VPN, deep links).
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
pub mod infra;
pub mod nebula;
pub mod notifications;
pub mod recovery;
pub mod sync;
mod utils;

use crate::auth::contacts::{add_contact, delete_contact, get_contacts, update_contact};
use crate::auth::login::{login_with_mnemonic, validate_mnemonic};
use crate::auth::logout::logout_full;
use crate::auth::oauth::{complete_oauth_flow, parse_oauth_deep_link, start_oauth_flow};
use crate::auth::session_restore::{is_token_valid, restore_session};
use crate::auth::ssh_keys::{create_ssh_key, delete_ssh_key, list_ssh_keys};
use crate::billing::charts::{
    calculate_storage_capacity, calculate_storage_cost, format_balance_chart, format_credits_chart, format_storage_chart,
    transform_marketplace_credits,
};
use crate::billing::credits::{check_sync_eligibility, get_user_credits};
use crate::billing::eligibility::check_action_eligibility;
use crate::billing::queries::{
    get_add_credit_events, get_balance_transfers, get_billing_transactions, get_credits, get_deposit_address, get_files_count, get_files_size,
    get_marketplace_credits, get_system_balance,
};
use crate::billing::subscriptions::{create_subscription, get_customer_portal_url, get_subscription_data};
use crate::blockchain::convert::{planck_to_hip_full, to_plancks};
use crate::blockchain::transfers::compute_max_transferable;
use crate::console_access::validate_recovery_password;
use crate::recovery::{check_recovery_state, mark_recovery_skipped, recover_mnemonic, seal_and_upload_mnemonic};
use crate::blockchain::queries::{get_account_balance, get_block_timestamp, get_referral_links, get_staking_info, validate_address};
use crate::blockchain::runtime::{get_wss_endpoint, test_rpc_endpoint_command, update_wss_endpoint_command};
use crate::blockchain::staking::{stake_bond, stake_claim_rewards, stake_unbond, stake_withdraw_unbonded};
use crate::blockchain::subscription::start_block_subscription;
use crate::blockchain::transfers::{transfer_balance, validate_send_balance};
use crate::infra::vm::{
    create_vm, get_vm_instance, list_vm_applications, list_vm_flavors, list_vm_images, list_vm_instances, reboot_vm, start_vm, stop_vm, terminate_vm,
};
use crate::notifications::credits::{
    check_low_credit_notification, create_credit_notifications, create_sync_notification, get_is_above_half_credit, is_first_time,
    mark_first_time_seen, process_credit_events, update_is_above_half_credit,
};
use crate::notifications::crud::{
    add_notification, clear_all_notifications, credit_already_notified, delete_all_notifications, delete_notification,
    delete_system_notification_by_version, get_last_deleted_low_credit_time, get_local_enabled_notification_types,
    get_local_notification_preferences, get_unread_count, has_active_low_credit_notification, hippius_version_notification_exists,
    list_notifications, low_credit_subtype_exists, mark_all_notifications_read, mark_notification_read, mark_notification_unread,
    update_local_notification_preferences,
};
use crate::notifications::settings::{get_notification_settings, update_notification_settings};
use crate::sync::control::{reveal_drive_in_finder, trigger_sync_now};
use crate::sync::device::{get_device_name, set_device_name};
use crate::sync::files::{
    add_file, add_files, add_folder, allow_asset_scope, delete_files, export_file, filter_file_entries, get_recent_files, get_user_files, list_sync_folder,
    resolve_file_info, resolve_file_path,
};
use crate::sync::folders::{delete_remote_folder, get_sync_folders_with_stats, list_remote_folders, restore_remote_folders};
use crate::sync::lifecycle::{
    add_local_sync_folder, auto_init_sync, change_sync_folder, initialize_sync, pause_drive, remove_drive, resume_drive, setup_and_init_sync,
    stop_sync,
};
use crate::sync::mnemonic::{ensure_sync_mnemonic, get_drive_mnemonic};
use crate::sync::paths::{get_sync_path, remove_sync_path, set_sync_path};
use crate::sync::progress::{sp_clear_all_data, sp_dismiss_sync_widget, sp_get_snapshot};
use crate::sync::remote::{download_remote_file, list_remote_folder_files};
use crate::sync::status::{app_close, get_all_drive_statuses, get_sync_activity_rows, get_sync_engine_health};
use crate::utils::platform_info::get_platform_info;
use crate::utils::preferences::{get_user_preference, is_onboarding_done, save_user_preference, set_onboarding_done};
use crate::utils::support::{
    create_support_ticket, get_support_ticket_messages, list_support_tickets, post_ticket_message, update_support_ticket, upload_ticket_attachment,
};
use crate::utils::tray_menu::get_tray_menu_data;
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
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

#[expect(clippy::too_many_lines, reason = "Tauri builder chain: handler registration must stay together")]
fn main() {
    load_env();

    // Initialize tracing subscriber to capture hcfs-client library logs.
    // Filter to show WARN and ERROR from hcfs-client, INFO and above from our code.
    // Set RUST_LOG env var to customize (e.g., RUST_LOG=hcfs_client=debug).
    use tracing_subscriber::{EnvFilter, fmt, prelude::*};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn,hcfs_client=info,Hippius=info"));
    tracing_subscriber::registry()
        .with(fmt::layer().with_target(true).with_file(false).with_line_number(false))
        .with(filter)
        .init();

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
                    info!("Deep link URL detected: {}", arg);
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
            list_sync_folder,
            get_recent_files,
            get_user_files,
            filter_file_entries,
            export_file,
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
            // VPN / Nebula
            crate::nebula::manager::get_nebula_ip,
            crate::nebula::manager::get_nebula_stats,
            crate::nebula::manager::get_nebula_status,
            crate::nebula::manager::get_nebula_binary_installed_status,
            crate::nebula::vpn::get_vpn_status,
            crate::nebula::vpn::toggle_vpn_status,
            crate::nebula::vpn::get_autoconnect_status,
            crate::nebula::vpn::toggle_autoconnect_status,
            crate::nebula::manager::check_nebula_requirements,
            crate::nebula::manager::download_nebula,
            crate::nebula::manager::install_nebula,
            crate::nebula::manager::verify_nebula,
            crate::nebula::manager::finish_setup,
            crate::nebula::manager::setup_nebula_background,
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
            to_plancks,
            planck_to_hip_full,
            compute_max_transferable,
            // Console access
            // Account recovery (OAuth-based)
            validate_recovery_password,
            check_recovery_state,
            recover_mnemonic,
            seal_and_upload_mnemonic,
            mark_recovery_skipped,
            // Block subscription
            start_block_subscription,
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
            // SSH keys
            list_ssh_keys,
            create_ssh_key,
            delete_ssh_key,
            // Billing & credits
            get_user_credits,
            get_credits,
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
            get_files_size,
            get_files_count,
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
            get_platform_info,
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
            format_storage_chart,
            format_balance_chart,
            transform_marketplace_credits,
            calculate_storage_cost,
            calculate_storage_capacity,
        ]);

    let builder = setup(builder);
    let builder = on_window_event(builder);

    info!("Running Tauri application...");
    builder.run(tauri::generate_context!()).expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// App setup (was setup.rs)
// ---------------------------------------------------------------------------

/// Register the window close handler on the Tauri builder.
///
/// Prevents the default close, stops Nebula, then exits cleanly.
pub fn on_window_event(builder: Builder<Wry>) -> Builder<Wry> {
    builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            info!("Close requested");
            api.prevent_close();
            let app_handle = window.app_handle().clone();

            tauri::async_runtime::spawn(async move {
                debug!("Stopping Nebula VPN...");
                // Stop Nebula before exiting
                let nebula_st = &app_handle.state::<crate::app_state::AppState>().nebula;
                if let Err(e) = crate::nebula::manager::stop_nebula(nebula_st).await {
                    warn!("Failed to stop Nebula: {}", e);
                }

                info!("Exiting application...");
                app_handle.exit(0);
            });
        }
    })
}

pub fn setup(builder: Builder<Wry>) -> Builder<Wry> {
    builder.setup(|app| {
        debug!(".setup() closure called in setup.rs");

        if let Ok(env_path) = app.path().resolve(".env", BaseDirectory::Resource) {
            let _ = dotenvy::from_filename(env_path);
        }

        // Register deep links for Linux at runtime (required for dev)
        #[cfg(target_os = "linux")]
        {
            debug!("Registering deep links for Linux...");
            match app.deep_link().register_all() {
                Ok(_) => info!("Deep links registered successfully for Linux"),
                Err(e) => error!("Failed to register deep links: {}", e),
            }
        }

        let app_handle = app.handle().clone();

        // Single AppState holds all mutable state — zero statics.
        let app_state = crate::app_state::AppState::new();
        app_state.sync_bridge.set_app_handle(app_handle.clone());
        app_handle.manage(app_state);
        let win = app.get_webview_window("main").expect("main window not found");

        if let Some(m) = win.current_monitor()? {
            let phys = m.size();
            let origin = m.position();

            let w = (phys.width as f64 * 0.8) as u32;
            let h = (phys.height as f64 * 0.9) as u32;

            let pos_x = origin.x + ((phys.width as i32 - w as i32) / 2);
            let pos_y = origin.y + ((phys.height as i32 - h as i32) / 2);

            win.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w, height: h }))?;
            win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: pos_x, y: pos_y }))?;
            win.show()?;
        }
        // Spawn async task for database initialization and Nebula setup
        tauri::async_runtime::spawn(async move {
            debug!("Async block started in setup.rs");

            // Database initialization
            let home_dir = dirs::home_dir().expect("Failed to get home directory");
            let db_dir = home_dir.join(".hippius");
            let db_path = db_dir.join("hippius.db");
            debug!("DB path: {}", db_path.display());

            std::fs::create_dir_all(&db_dir).expect("Failed to create .hippius directory");

            if !db_path.exists() {
                std::fs::File::create(&db_path).expect("Failed to create database file");
            }

            let db_url = format!("sqlite:{}", db_path.display());
            let pool = match SqlitePool::connect(&db_url).await {
                Ok(pool) => pool,
                Err(e) => {
                    error!("FATAL: Failed to open database at {}: {e}", db_path.display());
                    return; // cannot propagate from spawned task; error is logged
                }
            };
            app_handle.state::<crate::app_state::AppState>().set_pool(pool.clone());

            // Ensure all tables and columns exist
            if let Err(e) = crate::utils::schema::ensure_table_schema(&pool).await {
                error!("FATAL: Failed to ensure table schema: {}", e);
                return;
            }

            // Migrate account keys from 8-char to 16-char format
            if let Err(e) = crate::utils::schema::migrate_account_keys(&pool).await {
                warn!("Account key migration failed (non-fatal): {}", e);
            }

            // Collapse the legacy global `sync_user_stopped` preference
            // into per-drive `sync_paths.is_paused`. Idempotent — runs
            // every launch and short-circuits when already migrated.
            // See `sync::user_stopped_migration` for details.
            crate::sync::user_stopped_migration::run_at_startup(&pool).await;

            // Collapse duplicate welcome notifications from the pre-fix
            // era (the FE sent bare `"Welcome"` which bypassed the
            // `starts_with("Welcome-")` dedup guard, so every login
            // inserted a new row). Keeps the oldest per user so the
            // timestamp used by `process_credit_events` for event
            // filtering stays valid. Idempotent — a one-time sweep
            // that finds nothing to delete on subsequent launches.
            if let Err(e) = crate::notifications::crud::cleanup_duplicate_welcome_notifications(&pool).await {
                warn!("Welcome notification cleanup failed (non-fatal): {}", e);
            }

            // Check if autoconnect is enabled
            let autoconnect_enabled: bool = sqlx::query("SELECT is_enabled FROM autoconnect_vpn_enabled WHERE id = 1")
                .fetch_optional(&pool)
                .await
                .unwrap_or(None)
                .is_some_and(|row| row.get("is_enabled"));

            if autoconnect_enabled {
                debug!("Autoconnect enabled, skipping VPN status reset");
            } else {
                debug!("Resetting VPN status to FALSE on startup...");
                if let Err(e) = sqlx::query("UPDATE vpn_status SET is_enabled = FALSE WHERE id = 1").execute(&pool).await {
                    error!("Failed to reset VPN status: {}", e);
                }

                debug!("Ensuring Nebula is stopped on startup...");
                let nebula_st = &app_handle.state::<crate::app_state::AppState>().nebula;
                if let Err(e) = crate::nebula::manager::stop_nebula(nebula_st).await {
                    warn!("Failed to stop Nebula: {}", e);
                }
            }

            info!("Database initialized successfully");

            // Verify Nebula setup and certificates
            debug!("Verifying Nebula setup...");
            if let Err(e) = crate::nebula::manager::verify_nebula_setup(app_handle).await {
                warn!("{}", e);
            }
        });
        Ok(())
    })
}
