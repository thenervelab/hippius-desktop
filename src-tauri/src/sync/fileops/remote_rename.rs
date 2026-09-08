//! Rename a file inside a Drive folder that is NOT synced on this computer.
//!
//! The sync engine renames by observing a local move and reconciling; a
//! folder the user is only browsing has no local copy to move, so the
//! rename has to be stated to the server directly.
//!
//! `POST /rename_files` re-keys the record without moving the ciphertext:
//! the content is untouched, only its path identity changes. That is why a
//! rename must carry a `base_revision_id` — the server rejects one built
//! against a revision that has since moved on, which is what stops a
//! rename issued from a stale listing from silently clobbering a newer
//! change made elsewhere.

use ed25519_dalek::Signer;
use hcfs_shared::network::{BatchRenameRequest, SingleRename};
use sqlx::sqlite::SqlitePool;

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::identity::DriveIdentity;

use super::remote_upload::{signing_key_for_folder, wire_relative_path};

/// How many state rows to ask for per page while locating a file.
const STATE_PAGE: u32 = 500;

/// Pages to walk before giving up.
///
/// The revision lookup is a linear scan of the folder's state, so a very
/// large folder would otherwise let one rename issue an unbounded number
/// of requests. Refusing with a clear error beats hanging: the rename is
/// still possible from a device that syncs the folder.
const MAX_STATE_PAGES: u32 = 40;

/// The current revision of the file at `path_hash`, straight from the
/// server.
///
/// Read fresh rather than carried on the browse listing on purpose: the
/// listing may be minutes old, and a `base_revision_id` is precisely the
/// claim "I am changing the version I last saw". Sourcing it from stale
/// data would defeat the check it exists to make.
async fn current_revision_id(client: &hcfs_client::client::HcfsClient, ss58: &str, folder_hash: &str, path_hash: &[u8; 32]) -> Result<[u8; 32]> {
    let mut offset = 0u32;
    for _ in 0..MAX_STATE_PAGES {
        let page = client
            .get_state(ss58, folder_hash, offset, STATE_PAGE, None)
            .await
            .map_err(|e| AppError::Hcfs(format!("Could not read the folder's current state: {e}")))?;

        if let Some(found) = page.files.iter().find(|f| &f.path_hash == path_hash) {
            return Ok(found.revision_id);
        }
        if !page.has_more {
            return Err(AppError::NotFound(
                "That file is no longer in this folder — refresh and try again.".into(),
            ));
        }
        offset = offset.saturating_add(page.files.len().max(1) as u32);
    }
    Err(AppError::Validation(
        "This folder is too large to rename in from a device that does not sync it.".into(),
    ))
}

/// What to rename, and where.
///
/// A struct rather than eight positional parameters: `old_name` and
/// `new_name` are the same type and adjacent, which is a swap waiting to
/// happen, and swapping them here renames the file to itself and then
/// fails to find the original.
pub struct RemoteRename<'a> {
    pub account_id: &'a str,
    pub label: &'a str,
    /// Folder-relative path of the containing folder; empty for its root.
    pub parent_path: &'a str,
    pub old_name: &'a str,
    pub new_name: &'a str,
    pub identity: &'a DriveIdentity,
}

/// Rename one file in a folder this device does not sync.
pub async fn rename_in_remote_folder(state: &AppState, pool: &SqlitePool, req: RemoteRename<'_>) -> Result<()> {
    let RemoteRename {
        account_id,
        label,
        parent_path,
        old_name,
        new_name,
        identity,
    } = req;
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err(AppError::Validation("A file needs a name.".into()));
    }
    // The name is hashed and sealed into the path, so a separator here
    // would move the file rather than rename it — a different operation
    // with different permissions, arriving through the rename dialog.
    if new_name.contains('/') || new_name.contains('\\') {
        return Err(AppError::Validation("A file name cannot contain a slash.".into()));
    }
    if new_name == old_name {
        return Ok(());
    }

    let mnemonic = super::remote::session_mnemonic(state)?;
    let encryption_key = super::remote::encryption_key_for_label(pool, account_id, label, &mnemonic, identity).await?;
    let signing_key = signing_key_for_folder(&mnemonic, label)?;

    let old_relative = wire_relative_path(parent_path, old_name);
    let new_relative = wire_relative_path(parent_path, new_name);
    let old_path_hash = hcfs_client::crypto::compute_path_hash(&old_relative);
    let new_path_hash = hcfs_client::crypto::compute_path_hash(&new_relative);
    let new_encrypted_path = hcfs_client::crypto::encrypt_small(new_relative.as_bytes(), &encryption_key)
        .map_err(|e| AppError::Crypto(format!("Failed to seal the new path: {e}")))?;

    let folder_hash = hcfs_client::drive::keys::folder_hash(label);
    let client = super::remote::build_client(pool, account_id, identity).await?;
    let base_revision_id = current_revision_id(&client, account_id, &folder_hash, &old_path_hash).await?;

    let renames = vec![SingleRename {
        old_path_hash,
        new_path_hash,
        new_encrypted_path,
        new_file_name: Some(new_name.to_string()),
        new_relative_path: Some(new_relative),
        base_revision_id,
    }];

    // The signing text is generated by hcfs-shared, which the server uses
    // to verify — deriving our own would be a second definition of the
    // payload, and the two would diverge on the first field added.
    let signature = signing_key.sign(BatchRenameRequest::generate_signing_text(&renames).as_bytes());

    let request = BatchRenameRequest {
        ss58_address: account_id.to_string(),
        folder_hash,
        renames,
        signature: signature.to_bytes(),
        signing_key: signing_key.verifying_key().to_bytes(),
    };

    client
        .rename_files(&request)
        .await
        .map_err(|e| AppError::Hcfs(format!("Rename failed: {e}")))?;
    Ok(())
}

/// Rename a file in a folder that is not synced on this computer.
#[tauri::command]
pub async fn rename_remote_file(
    state: tauri::State<'_, AppState>,
    account_id: String,
    label: String,
    parent_path: Option<String>,
    old_name: String,
    new_name: String,
) -> Result<()> {
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, &account_id, &label).await?;
    rename_in_remote_folder(
        state.inner(),
        pool,
        RemoteRename {
            account_id: &account_id,
            label: &label,
            parent_path: &parent_path.unwrap_or_default(),
            old_name: &old_name,
            new_name: &new_name,
            identity: &identity,
        },
    )
    .await
}
