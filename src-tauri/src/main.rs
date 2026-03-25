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

mod api_client;
mod api_client_logic;
mod app_state;
mod block_subscription;
mod builder_blocks;
mod commands;
mod constants;
mod hcfs_drive;
mod macos_bookmarks;
mod substrate_client;
mod sync_engine;
mod sync_events;
mod sync_logic;
mod sync_progress;
mod sync_shared;
mod utils;

use crate::commands::sync_status::{
    app_close, get_sync_activity, get_sync_engine_health, get_sync_status,
};
use crate::commands::syncing::{
    delete_remote_folder, get_device_name, get_drive_mnemonic, get_remote_storage_stats,
    initialize_sync, is_drive_active, list_remote_folders, persist_master_mnemonic,
    reset_sync_data, restore_remote_folders, set_device_name, stop_drive, stop_sync,
    trigger_sync_now,
};
use crate::sync_progress::{
    sp_clear_all_data, sp_complete_pending_files, sp_complete_session, sp_get_overall_progress,
    sp_get_snapshot, sp_mark_all_pending_files_as_failed, sp_mark_file_error,
    sp_mark_pending_files_as_failed, sp_merge_into_session, sp_record_deleted_file,
    sp_remove_files_for_label, sp_start_session, sp_stop_session, sp_update_file_progress,
};
use block_subscription::{
    get_current_block_number, start_block_subscription, stop_block_subscription,
};
use builder_blocks::{on_window_event::on_window_event, setup::setup};
use commands::accounts::{
    export_app_data, get_all_subaccount_addresses, import_app_data, reset_app,
};
use commands::auth::{
    auth_logout, generate_mnemonic, get_eth_address, get_polkadot_address, login_with_mnemonic,
    refresh_auth_token, set_passcode, unlock_with_passcode, validate_mnemonic,
};
use commands::billing::{
    create_subscription, get_active_subscription, get_add_credit_events, get_balance_transfers,
    get_billing_transactions, get_customer_portal_url, get_deposit_address, get_file_nodes,
    get_files_size, get_indexer_credits, get_marketplace_credits, get_node_locations,
    get_subscription_plans, get_system_balance_history, get_user_credits_balance,
};
use commands::blockchain::{
    from_plancks, get_account_balance, get_block_timestamp, get_explorer_url, get_referral_links,
    get_staking_info, stake_bond, stake_claim_rewards, stake_unbond, stake_withdraw_unbonded,
    to_plancks, transfer_balance, validate_address,
};
use commands::chart_formatting::{
    calculate_storage_cost, format_balance_chart, format_credits_chart, format_storage_chart,
    transform_marketplace_credits,
};
use commands::file_commands::{
    add_file, add_folder, allow_asset_scope, export_file, get_synced_file_metadata,
    list_sync_folder, remove_file, resolve_file_path,
};
use commands::local_db::{
    add_contact, add_notification, clear_all_notifications, credit_already_notified,
    delete_all_notifications, delete_contact, delete_notification,
    delete_system_notification_by_version, get_contacts, get_is_above_half_credit,
    get_last_deleted_low_credit_time, get_local_enabled_notification_types,
    get_local_notification_preferences, get_unread_count, get_user_preference,
    has_active_low_credit_notification, hippius_version_notification_exists, is_first_time,
    is_onboarding_done, list_notifications, low_credit_subtype_exists, mark_all_notifications_read,
    mark_first_time_seen, mark_notification_read, mark_notification_unread, save_user_preference,
    set_onboarding_done, update_contact, update_is_above_half_credit,
    update_local_notification_preferences,
};
use commands::notifications::{get_notification_settings, update_notification_settings};
use commands::oauth::{complete_oauth_flow, start_oauth_flow};
use commands::remote_browse::{download_remote_file, list_remote_folder_files};
use commands::session::{
    clear_auth_session, clear_wallet, get_auth_session, get_auth_token, get_last_auth_session,
    get_wallet, has_wallet, is_token_valid, save_api_token_command, save_auth_session, save_wallet,
    update_logout_time,
};
use commands::ssh_keys::{create_ssh_key, delete_ssh_key, list_ssh_keys};
use commands::substrate_tx::{
    get_all_sync_paths, get_sync_path, get_wss_endpoint, remove_sync_path, set_sync_path,
    transfer_balance_tauri, update_wss_endpoint_command,
};
use commands::support::{
    create_support_ticket, get_support_ticket_messages, list_support_tickets, post_ticket_message,
    update_support_ticket,
};
use commands::vm::{
    create_vm, get_vm_instance, list_vm_applications, list_vm_flavors, list_vm_images,
    list_vm_instances, reboot_vm, start_vm, stop_vm, terminate_vm,
};
use tauri::{Builder, Emitter, Manager};
use tracing::{debug, info};

/// Load environment variables from `.env` file(s). Tries both the working
/// directory and the `CARGO_MANIFEST_DIR` path (for development builds).
fn load_env() {
    let _ = dotenvy::dotenv();
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let env_path = format!("{}/.env", manifest_dir);
    let _ = dotenvy::from_filename(env_path);
}

fn main() {
    load_env();

    // Initialize tracing subscriber to capture hcfs-client library logs.
    // Filter to show WARN and ERROR from hcfs-client, INFO and above from our code.
    // Set RUST_LOG env var to customize (e.g., RUST_LOG=hcfs_client=debug).
    use tracing_subscriber::{EnvFilter, fmt, prelude::*};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("warn,hcfs_client=info,Hippius=info"));
    tracing_subscriber::registry()
        .with(
            fmt::layer()
                .with_target(true)
                .with_file(false)
                .with_line_number(false),
        )
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
        .plugin(tauri_plugin_http::init())
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
            stop_sync,
            stop_drive,
            reset_sync_data,
            trigger_sync_now,
            is_drive_active,
            // Sync status
            get_sync_status,
            get_sync_activity,
            get_sync_engine_health,
            // File operations
            add_file,
            add_folder,
            remove_file,
            list_sync_folder,
            get_synced_file_metadata,
            export_file,
            resolve_file_path,
            allow_asset_scope,
            // App lifecycle
            app_close,
            // Substrate / blockchain
            get_sync_path,
            get_all_sync_paths,
            set_sync_path,
            remove_sync_path,
            transfer_balance_tauri,
            get_wss_endpoint,
            update_wss_endpoint_command,
            // Account management
            reset_app,
            get_all_subaccount_addresses,
            import_app_data,
            export_app_data,
            // VPN / Nebula
            utils::nebula::get_nebula_version,
            utils::nebula::check_nebula_update,
            utils::nebula::get_nebula_ip,
            utils::nebula::get_nebula_stats,
            utils::nebula::get_nebula_status,
            utils::nebula::get_nebula_binary_installed_status,
            commands::vpn_enabled::get_vpn_status,
            commands::vpn_enabled::toggle_vpn_status,
            commands::vpn_enabled::get_autoconnect_status,
            commands::vpn_enabled::toggle_autoconnect_status,
            utils::nebula::check_nebula_requirements,
            utils::nebula::download_nebula,
            utils::nebula::install_nebula,
            utils::nebula::verify_nebula,
            utils::nebula::finish_setup,
            utils::nebula::start_nebula,
            // Indexer
            commands::indexer::get_indexer_api_key,
            // API token persistence
            save_api_token_command,
            // HCFS mnemonic management
            get_drive_mnemonic,
            persist_master_mnemonic,
            // Billing auth (Ethereum challenge-response)
            commands::billing_auth::billing_auth,
            // HCFS config commands
            commands::syncing::save_hcfs_config,
            commands::syncing::get_hcfs_config,
            commands::syncing::update_hcfs_server_url,
            commands::syncing::update_sync_bearer_token,
            // Selective sync (exclusion patterns)
            commands::selective_sync::list_exclude_patterns,
            commands::selective_sync::add_exclude_pattern,
            commands::selective_sync::remove_exclude_pattern,
            commands::selective_sync::is_file_excluded,
            // Stage & conflict resolution
            commands::syncing::stage_changes,
            commands::syncing::sync_with_conflict_resolutions,
            commands::syncing::cancel_review,
            // Encrypted backup
            commands::syncing::create_encrypted_backup,
            // Remote storage stats (all files)
            get_remote_storage_stats,
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
            commands::migration::check_migration,
            commands::migration::start_migration,
            commands::migration::cancel_migration,
            commands::migration::dismiss_migration,
            commands::migration::complete_migration_transition,
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
            get_referral_links,
            to_plancks,
            from_plancks,
            get_explorer_url,
            // Block subscription
            start_block_subscription,
            stop_block_subscription,
            get_current_block_number,
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
            get_user_credits_balance,
            get_billing_transactions,
            get_subscription_plans,
            get_active_subscription,
            create_subscription,
            get_customer_portal_url,
            get_indexer_credits,
            get_marketplace_credits,
            get_system_balance_history,
            get_balance_transfers,
            get_add_credit_events,
            get_files_size,
            get_file_nodes,
            get_node_locations,
            get_deposit_address,
            // Notifications
            get_notification_settings,
            update_notification_settings,
            // Support tickets
            list_support_tickets,
            get_support_ticket_messages,
            create_support_ticket,
            update_support_ticket,
            post_ticket_message,
            // OAuth
            start_oauth_flow,
            complete_oauth_flow,
            // Authentication & crypto
            login_with_mnemonic,
            unlock_with_passcode,
            set_passcode,
            validate_mnemonic,
            refresh_auth_token,
            auth_logout,
            get_polkadot_address,
            get_eth_address,
            generate_mnemonic,
            // Session & wallet credential storage
            save_wallet,
            get_wallet,
            has_wallet,
            clear_wallet,
            save_auth_session,
            get_auth_session,
            get_auth_token,
            get_last_auth_session,
            clear_auth_session,
            is_token_valid,
            update_logout_time,
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
            sp_start_session,
            sp_merge_into_session,
            sp_complete_session,
            sp_stop_session,
            sp_update_file_progress,
            sp_complete_pending_files,
            sp_mark_pending_files_as_failed,
            sp_mark_all_pending_files_as_failed,
            sp_mark_file_error,
            sp_get_overall_progress,
            sp_record_deleted_file,
            sp_remove_files_for_label,
            sp_clear_all_data,
            sp_get_snapshot,
            // Chart data formatting
            format_credits_chart,
            format_storage_chart,
            format_balance_chart,
            transform_marketplace_credits,
            calculate_storage_cost,
        ]);

    let builder = setup(builder);
    let builder = on_window_event(builder);

    info!("Running Tauri application...");
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
