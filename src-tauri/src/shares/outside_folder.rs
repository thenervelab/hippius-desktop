//! Share a folder that lives outside every synced drive as a link.
//!
//! An in-drive folder link reads the drive's server-side records; an
//! outside folder has none, so its files are uploaded as a copy under the
//! link's own key (hcfs-client `create_upload_folder_share`). The copy never
//! enters a drive and never shows in the user's Drive, and the server
//! deletes it when the link expires or is revoked. Recipients and the owner
//! listing treat the result like any other folder link.
//!
//! EVERY gate lives in [`share_outside_folder`], not in its caller. That is
//! the lesson `create_folder_share_inner` records: the Finder dispatcher
//! calls the funnel directly, and a guard one level up would not cover it.

use std::path::Path;

use hcfs_client::client::folder_share::{FolderShareError, UploadFolderShareOptions};
use hcfs_client::client::share::{ShareKeystore, ShareProgressFn, ShareTtl};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::app_state::AppState;
use crate::billing::eligibility::{InsufficientCreditsAction, require_eligible};
use crate::error::{AppError, NotReadyKind, Result};
use crate::shares::SqliteShareKeystore;
use crate::shares::capabilities::fetch_capabilities;
use crate::shares::client::build_account_client;
use crate::shares::commands::{ShareChoice, ShareLink, console_base_url};
use crate::shares::folder_scan::{FolderScan, scan_folder};

/// Refusal on a server without uploaded-copy folder links. The mock-server
/// suite asserts it verbatim.
pub const UPLOAD_FOLDER_SHARES_UNAVAILABLE: &str = "Sharing folders from outside a Hippius drive isn't available yet.";

/// What a cancelled share reports, worded like every other Finder share's
/// cancel so the modal treats both alike.
pub const SHARE_CANCELLED: &str = "Share cancelled.";

/// One outside-folder share, bundled so the entry point stays within five
/// parameters.
pub struct OutsideFolderShare<'a> {
    /// The clicked folder, canonical from Finder.
    pub folder: &'a Path,
    pub ttl: ShareTtl,
    pub choice: ShareChoice,
    /// Encrypt, upload, finalize, summed across files by hcfs-client.
    pub progress: Option<ShareProgressFn>,
    /// The modal's Cancel. Passed INTO the upload, never raced against it:
    /// the client has to get to send the abort that tears down the
    /// half-built link on the server, and a dropped future sends nothing.
    pub cancel: CancellationToken,
}

/// Upload `request.folder` as a copy and return its folder link.
///
/// The order is the point. The capability probe comes first, so an older
/// server refuses before the disk is walked. The scan comes before the gate,
/// because the gate needs the real bytes. The gate comes before any upload
/// request, so an account over its plan uploads nothing. The owner wrap
/// comes last, because only a sealed link has a secret worth wrapping.
///
/// # Errors
///
/// [`AppError::Validation`] for the capability refusal, every scan refusal,
/// every refusal a person can act on, and a cancel;
/// `NotReady(StorageLimitReached)` from the quota gate or the server's own
/// 402; [`AppError::Hcfs`] for transport and other server failures.
pub async fn share_outside_folder(state: &AppState, account_id: &str, request: OutsideFolderShare<'_>) -> Result<ShareLink> {
    require_upload_folder_shares_supported(state, account_id).await?;
    let scan = scan_off_main_thread(request.folder).await?;
    // The server bills the copy against the Drive quota, so the gate asks
    // about the bytes the copy will hold, same as a file share.
    require_eligible(state, account_id, InsufficientCreditsAction::Sharing, scan.total_bytes).await?;

    let display_name = folder_display_name(request.folder)?;
    // One line per share, never per file: the support bundle caps each log.
    info!(
        folder = %display_name,
        file_count = scan.file_count,
        entry_count = scan.entries.len(),
        total_bytes = scan.total_bytes,
        "Creating uploaded-copy folder share"
    );

    let pool = state.pool()?;
    let client = build_account_client(pool, account_id).await?;
    let keystore = SqliteShareKeystore::new(pool.clone());
    let console_base = console_base_url();
    let options = UploadFolderShareOptions {
        display_name: &display_name,
        ttl: request.ttl,
        password: request.choice.password(),
        console_base_url: &console_base,
    };
    let created = client
        .create_upload_folder_share(scan.entries, &options, &keystore, request.progress, request.cancel)
        .await
        .map_err(|e| {
            warn!(error = %e, "create_upload_folder_share failed");
            map_upload_folder_share_error(e)
        })?;

    // The client does not push the owner wrap; without it the console's
    // Copy works on this device only. Same call, same inputs as a drive
    // folder link, so the console opens both the same way.
    if let Ok(Some(secret)) = keystore.get(&created.share_token) {
        super::owner_wrap::push_folder_for_account(state, account_id, &[(created.share_token.clone(), secret)]).await;
    }

    Ok(ShareLink {
        share_token: created.share_token,
        share_url: created.share_url,
        expires_at: created.expires_at.map(|e| e.to_rfc3339()),
        password: request.choice.into_password(),
    })
}

/// Capability gate. It is this path's own authority: the Finder menu shows
/// on every folder, so nothing upstream filtered an older server out.
async fn require_upload_folder_shares_supported(state: &AppState, account_id: &str) -> Result<()> {
    let caps = fetch_capabilities(state, account_id).await?;
    if !caps.upload_folder_shares {
        return Err(AppError::Validation(UPLOAD_FOLDER_SHARES_UNAVAILABLE.into()));
    }
    Ok(())
}

/// The scan is up to 50,000 stats, so it runs on the blocking pool and never
/// on the async worker or the main thread.
async fn scan_off_main_thread(folder: &Path) -> Result<FolderScan> {
    let folder = folder.to_path_buf();
    tokio::task::spawn_blocking(move || scan_folder(&folder))
        .await
        .map_err(|e| AppError::Other(format!("Could not read that folder: {e}")))?
}

/// The recipient page's title: the folder's own name.
fn folder_display_name(folder: &Path) -> Result<String> {
    folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Validation("This folder has no name to share it under.".into()))
}

/// Map the upload's failures onto the app taxonomy, by variant and never by
/// message text. Everything a person can act on is a `Validation` sentence
/// the modal shows verbatim, naming the item where the variant has one:
/// "something changed" with 50,000 candidates is no help.
///
/// Split in three by kind of failure (link lifecycle, folder contents, one
/// item) to keep each match small.
fn map_upload_folder_share_error(e: FolderShareError) -> AppError {
    match e {
        FolderShareError::Server { status, message: _ } => map_upload_server_status(status),
        FolderShareError::Cancelled => AppError::Validation(SHARE_CANCELLED.into()),
        FolderShareError::NotFound => {
            AppError::Validation("The link expired or was removed while the folder was uploading. Share the folder again.".into())
        }
        FolderShareError::TooManyUploadsInProgress { max } => AppError::Validation(format!(
            "{max} folder shares are already uploading. Wait for one to finish or cancel it, then share again."
        )),
        other => map_folder_refusal(other),
    }
}

/// Refusals about the folder as a whole.
fn map_folder_refusal(e: FolderShareError) -> AppError {
    match e {
        FolderShareError::EmptyFolder => AppError::Validation("This folder has no files to share.".into()),
        // Counts files AND folders, so the copy must not say "files".
        FolderShareError::TooManyItems { count, max } => AppError::Validation(format!(
            "This folder holds {count} items (files and folders), and a link can hold at most {max}. \
             Share a smaller folder."
        )),
        FolderShareError::DirListTooLarge { bytes: _, max: _ } => AppError::Validation(
            "This folder's empty subfolders have names too long to share together. Remove or shorten \
             some of them, then share again."
                .into(),
        ),
        other => map_item_refusal(other),
    }
}

/// Refusals about one item, each naming it; then everything that is not the
/// user's to fix.
fn map_item_refusal(e: FolderShareError) -> AppError {
    match e {
        FolderShareError::InvalidPath { relative_path, reason } => {
            // The validator's reason is engineer wording; it goes to the log.
            warn!(%reason, "uploaded-copy share refused a name");
            AppError::Validation(format!(
                "\u{201c}{relative_path}\u{201d} has a name a link can't hold (a special character, or too \
                 long). Rename it, then share again."
            ))
        }
        FolderShareError::FileTooLarge { relative_path, size: _ } => {
            AppError::Validation(format!("\u{201c}{relative_path}\u{201d} is too large to share in a folder link."))
        }
        FolderShareError::PathCollision { relative_path } => AppError::Validation(format!(
            "Two items in this folder are both named \u{201c}{relative_path}\u{201d}. Rename one, then share again."
        )),
        FolderShareError::SourceChanged { relative_path } => AppError::Validation(format!(
            "\u{201c}{relative_path}\u{201d} changed while the folder was being shared, so the link was \
             cancelled. If something is still copying into the folder, wait for it to finish, then share again."
        )),
        FolderShareError::SourceUnreadable { relative_path, source } => {
            warn!(error = %source, "uploaded-copy share could not read a file");
            AppError::Validation(format!(
                "\u{201c}{relative_path}\u{201d} couldn't be read. Check that you can open it, then share again."
            ))
        }
        // Transport, configuration and crypto failures, plus any variant a
        // later hcfs-client adds (the enum is non_exhaustive): not the
        // user's to fix, so they keep the engineer wording.
        other => AppError::Hcfs(format!("create_upload_folder_share: {other}")),
    }
}

/// A server status the client passed through unmapped. 402 is the server's
/// own quota gate (raced past ours, or the hold's re-check), so it opens the
/// same plans dialog; 502/503 mean billing could not be reached.
fn map_upload_server_status(status: u16) -> AppError {
    match status {
        402 => AppError::NotReady(NotReadyKind::StorageLimitReached),
        502 | 503 => AppError::Validation("Hippius couldn't check your storage plan just now. Try again in a few minutes.".into()),
        401 | 403 => AppError::Auth(format!("uploaded-copy folder share rejected (status {status})")),
        _ => AppError::Hcfs(format!("create_upload_folder_share failed (status {status})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validation(e: FolderShareError) -> String {
        match map_upload_folder_share_error(e) {
            AppError::Validation(message) => message,
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    fn named(path: &str) -> String {
        format!("\u{201c}{path}\u{201d}")
    }

    #[test]
    fn a_cancel_reads_like_every_other_finder_cancel() {
        assert_eq!(validation(FolderShareError::Cancelled), SHARE_CANCELLED);
    }

    #[test]
    fn a_link_gone_mid_upload_says_to_share_again() {
        let message = validation(FolderShareError::NotFound);
        assert!(
            message.contains("expired or was removed") && message.contains("Share the folder again"),
            "{message}"
        );
    }

    #[test]
    fn too_many_uploads_names_the_limit_and_the_way_out() {
        let message = validation(FolderShareError::TooManyUploadsInProgress { max: 8 });
        assert!(message.starts_with("8 folder shares are already uploading"), "{message}");
        assert!(message.contains("Wait for one to finish or cancel it"), "{message}");
    }

    #[test]
    fn an_empty_folder_says_it_has_no_files() {
        assert!(validation(FolderShareError::EmptyFolder).contains("no files"));
    }

    #[test]
    fn too_many_items_counts_files_and_folders() {
        let message = validation(FolderShareError::TooManyItems { count: 50_001, max: 50_000 });
        assert!(
            message.contains("50001 items (files and folders)") && message.contains("at most 50000"),
            "{message}"
        );
    }

    #[test]
    fn long_empty_folder_names_say_what_to_shorten() {
        let message = validation(FolderShareError::DirListTooLarge {
            bytes: 300_000,
            max: 262_144,
        });
        assert!(message.contains("empty subfolders"), "{message}");
    }

    #[test]
    fn a_bad_name_is_named_without_the_validator_jargon() {
        let message = validation(FolderShareError::InvalidPath {
            relative_path: "a\\b.txt".into(),
            reason: "path contains a backslash".into(),
        });
        assert!(message.contains(&named("a\\b.txt")) && message.contains("Rename it"), "{message}");
        assert!(!message.contains("backslash"), "{message}");
    }

    #[test]
    fn a_too_large_file_is_named() {
        let message = validation(FolderShareError::FileTooLarge {
            relative_path: "video/raw.mov".into(),
            size: 6 << 30,
        });
        assert!(message.contains(&named("video/raw.mov")) && message.contains("too large"), "{message}");
    }

    #[test]
    fn a_collision_names_the_item_to_rename() {
        let message = validation(FolderShareError::PathCollision {
            relative_path: "caf\u{e9}.txt".into(),
        });
        assert!(message.contains(&named("caf\u{e9}.txt")) && message.contains("Rename one"), "{message}");
    }

    #[test]
    fn a_changed_file_is_named() {
        let message = validation(FolderShareError::SourceChanged {
            relative_path: "photos/IMG_1.heic".into(),
        });
        assert!(message.contains(&named("photos/IMG_1.heic")) && message.contains("changed"), "{message}");
    }

    #[test]
    fn an_unreadable_file_is_named() {
        let message = validation(FolderShareError::SourceUnreadable {
            relative_path: "locked.pdf".into(),
            source: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        });
        assert!(
            message.contains(&named("locked.pdf")) && message.contains("couldn't be read"),
            "{message}"
        );
    }

    #[test]
    fn a_server_402_opens_the_plans_dialog() {
        let mapped = map_upload_folder_share_error(FolderShareError::Server {
            status: 402,
            message: "drive_quota_exceeded".into(),
        });
        assert!(matches!(mapped, AppError::NotReady(NotReadyKind::StorageLimitReached)), "{mapped:?}");
    }

    #[test]
    fn billing_unavailable_says_try_again_later() {
        for status in [502, 503] {
            let message = validation(FolderShareError::Server {
                status,
                message: "billing_unavailable".into(),
            });
            assert!(message.contains("Try again in a few minutes"), "{status}: {message}");
        }
    }

    #[test]
    fn other_failures_stay_engineer_errors() {
        let unauthorized = map_upload_folder_share_error(FolderShareError::Server {
            status: 401,
            message: String::new(),
        });
        assert!(matches!(unauthorized, AppError::Auth(_)), "{unauthorized:?}");

        for e in [
            FolderShareError::Server {
                status: 500,
                message: String::new(),
            },
            FolderShareError::Network("connection reset".into()),
            FolderShareError::MissingFolderHash,
        ] {
            let mapped = map_upload_folder_share_error(e);
            assert!(matches!(mapped, AppError::Hcfs(_)), "{mapped:?}");
        }
    }

    #[test]
    fn the_display_name_is_the_folder_s_own_name() {
        assert_eq!(folder_display_name(Path::new("/Users/me/Downloads/T2-KD")).unwrap(), "T2-KD");
        assert!(folder_display_name(Path::new("/")).is_err());
    }

    /// Body of `share_outside_folder`, from its signature to its closing brace.
    fn funnel_body() -> String {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/shares/outside_folder.rs")).expect("read outside_folder.rs");
        let start = src.find("pub async fn share_outside_folder(").expect("funnel exists");
        let end = src[start..].find("\n}\n").expect("funnel closes") + start;
        src[start..end].to_string()
    }

    /// The gate order is the security property: capability, then the real
    /// bytes, then the quota gate, then the upload, then the owner wrap.
    /// Behaviour is covered in `tests/shares_server_mock.rs`; this pin keeps
    /// a refactor from reordering the steps while those tests still pass.
    #[test]
    fn the_funnel_gates_before_it_uploads() {
        let body = funnel_body();
        let at = |needle: &str| body.find(needle).unwrap_or_else(|| panic!("funnel must call {needle}"));
        let order = [
            at("require_upload_folder_shares_supported("),
            at("scan_off_main_thread("),
            at("require_eligible(state, account_id, InsufficientCreditsAction::Sharing, scan.total_bytes)"),
            at(".create_upload_folder_share("),
            at("push_folder_for_account("),
        ];
        assert!(order.windows(2).all(|w| w[0] < w[1]), "funnel steps out of order: {order:?}");
    }

    /// The modal's Cancel must reach the client, which then aborts the link
    /// on the server. A fresh token here would compile, pass the success
    /// test, and leave every cancelled share uploading until the reaper.
    #[test]
    fn the_funnel_hands_the_cancel_token_to_the_upload() {
        let body = funnel_body();
        assert!(body.contains("request.progress, request.cancel)"), "the upload must take request.cancel");
        assert!(!body.contains("CancellationToken::new()"), "never a fresh token");
        assert!(!body.contains("select!"), "never race the upload; the client must get to abort");
    }
}
