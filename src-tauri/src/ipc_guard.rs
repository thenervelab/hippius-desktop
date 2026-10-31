//! Which windows may call the app's most sensitive commands.
//!
//! Every webview the app opens (the main window, the tray popover, the
//! capture overlays, the recording pill, the camera bubble, the capture card)
//! shares one invoke handler, and Tauri's capability files only gate plugin
//! commands: app-defined commands are callable from any window unless the
//! build ships an app manifest. The small windows float over every app and
//! render remote-derived text (file names, account details), so a flaw in one
//! of them must not be able to read the recovery phrase, export a wallet,
//! move money or delete files.
//!
//! [`main_window_only`] wraps the generated handler and refuses the commands
//! in [`MAIN_WINDOW_ONLY`] unless they come from the main window. Everything
//! else passes through untouched, so a window that needs a command not on
//! this list keeps working. `app/lib/__tests__/mainWindowOnlyCommands.test.ts`
//! walks every other window's code and fails if it calls one of these.

use tauri::Runtime;
use tauri::ipc::Invoke;

use crate::error::AppError;

/// Label of the main app window (Tauri's default for the window declared in
/// `tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";

/// Commands only the main window may call. Grouped by why they are here.
pub const MAIN_WINDOW_ONLY: &[&str] = &[
    // The recovery phrase, keys, tokens and the passwords that unlock them.
    "get_drive_mnemonic",
    "ensure_sync_mnemonic",
    "local_wallet_get_decrypted_mnemonic",
    "local_wallet_generate_mnemonic",
    "local_wallet_export_backup",
    "local_wallet_export_backup_zip",
    "local_wallet_verify_password",
    "recover_mnemonic",
    "restore_with_mnemonic",
    "login_with_mnemonic",
    "seal_and_upload_mnemonic",
    "create_encrypted_backup",
    "probe_rekey_recovery",
    "chat_derive_secret_storage_key",
    "chat_get_session",
    "chat_refresh_tokens",
    "chat_complete_sign_in",
    "validate_recovery_password",
    "change_recovery_password",
    "reset_unlock_password",
    "resume_recovery_password_rotation",
    "save_hcfs_config",
    // Accounts and wallets on this device.
    "local_wallet_create",
    "local_wallet_delete",
    "local_wallet_import_encrypted_backup",
    "local_wallet_import_encrypted_backup_from_zip",
    "local_wallet_rename",
    "local_wallet_set_active",
    "logout_full",
    "sp_clear_all_data",
    "cancel_account_recovery",
    "recover_account_files",
    // Money: transfers, staking, the bridge and plan changes.
    "transfer_balance",
    "stake_bond",
    "stake_unbond",
    "stake_withdraw_unbonded",
    "stake_claim_rewards",
    "bridge_alpha_to_halpha",
    "bridge_halpha_to_alpha",
    "create_subscription",
    "subscribe_drive_plan",
    "change_drive_plan",
    "cancel_drive_subscription",
    "start_drive_card_checkout",
    // Deletes, revokes and leaving shared drives.
    "delete_files",
    "delete_remote_folder",
    "confirm_mass_delete",
    "confirm_empty_remote",
    "remove_drive",
    "remove_drive_member",
    "leave_shared_drive",
    "leave_shared_drive_by_identity",
    "revoke_drive_invite",
    "hcfs_revoke_share",
    "hcfs_revoke_folder_share",
    "hcfs_revoke_folder_share_by_hash",
    "hcfs_clear_share_history",
    "hcfs_remove_share_history",
    "create_ssh_key",
    "delete_ssh_key",
    "delete_contact",
    "remove_sync_path",
    "terminate_vm",
    // Exports, saves and anything that widens what the app reads or where it
    // talks to.
    "export_file",
    "export_folder_zip",
    "chat_save_attachment",
    "attach_logs_to_ticket",
    "allow_asset_scope",
    "set_sync_path",
    "change_sync_folder",
    "update_wss_endpoint_command",
    "switch_release_channel",
    "install_update",
];

/// Whether the window labelled `window` may call `command`.
pub fn allowed(command: &str, window: &str) -> bool {
    window == MAIN_WINDOW || !MAIN_WINDOW_ONLY.contains(&command)
}

/// Wrap the generated invoke handler so the commands in [`MAIN_WINDOW_ONLY`]
/// are refused from every other window. A refusal is logged and rejected
/// with a `Validation` error, like any other bad request.
pub fn main_window_only<R, H>(handler: H) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static
where
    R: Runtime,
    H: Fn(Invoke<R>) -> bool + Send + Sync + 'static,
{
    move |invoke: Invoke<R>| {
        let command = invoke.message.command();
        let window = invoke.message.webview_ref().label();
        if allowed(command, window) {
            return handler(invoke);
        }
        tracing::warn!(command, window, "refused a main-window-only command from another window");
        invoke
            .resolver
            .reject(AppError::Validation(format!("{command} can only be used from the main window")));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_may_call_everything() {
        for command in MAIN_WINDOW_ONLY {
            assert!(allowed(command, MAIN_WINDOW), "{command}");
        }
        assert!(allowed("capture_state", MAIN_WINDOW));
    }

    #[test]
    fn other_windows_are_refused_the_sensitive_commands() {
        for window in ["tray-panel", "capture-preview", "capture-overlay-1", "capture-controls", "capture-camera"] {
            for command in [
                "get_drive_mnemonic",
                "chat_derive_secret_storage_key",
                "local_wallet_export_backup_zip",
                "delete_files",
                "export_file",
                "transfer_balance",
            ] {
                assert!(!allowed(command, window), "{window} must not call {command}");
            }
        }
    }

    #[test]
    fn other_windows_keep_their_own_commands() {
        // A sample of what the small windows really call (see each window's
        // capability file): none of it may be caught by the list.
        for (window, command) in [
            ("tray-panel", "get_tray_menu_data"),
            ("tray-panel", "copy_file_share_link"),
            ("tray-panel", "reveal_path_in_file_manager"),
            ("capture-preview", "capture_preview_revoke_link"),
            ("capture-preview", "share_list_comments"),
            ("capture-overlay-1", "capture_select"),
            ("capture-controls", "capture_stop"),
            ("capture-camera", "capture_camera_set_size"),
        ] {
            assert!(allowed(command, window), "{window} must still call {command}");
        }
    }

    #[test]
    fn a_lookalike_label_is_not_the_main_window() {
        assert!(!allowed("get_drive_mnemonic", "main-2"));
        assert!(!allowed("get_drive_mnemonic", "Main"));
        assert!(!allowed("get_drive_mnemonic", ""));
    }

    /// Every entry must name a registered command, or a rename would silently
    /// drop its guard.
    #[test]
    fn every_listed_command_is_registered() {
        let main = include_str!("main.rs");
        let start = main.find("generate_handler![").expect("generate_handler! in main.rs");
        let end = start + main[start..].find("])").expect("end of generate_handler!");
        let registered: std::collections::HashSet<&str> = main[start..end]
            .lines()
            .map(|line| line.split("//").next().unwrap_or_default())
            .flat_map(|line| line.split(','))
            .filter_map(|entry| entry.trim().rsplit("::").next())
            .filter(|name| !name.is_empty())
            .collect();
        for command in MAIN_WINDOW_ONLY {
            assert!(registered.contains(command), "{command} is not registered in main.rs");
        }
        let unique: std::collections::HashSet<_> = MAIN_WINDOW_ONLY.iter().collect();
        assert_eq!(unique.len(), MAIN_WINDOW_ONLY.len(), "duplicate entry");
    }

    #[test]
    fn main_rs_wraps_the_handler() {
        let main = include_str!("main.rs");
        assert!(
            main.contains("invoke_handler(crate::ipc_guard::main_window_only(tauri::generate_handler!["),
            "the invoke handler must go through main_window_only"
        );
    }
}
