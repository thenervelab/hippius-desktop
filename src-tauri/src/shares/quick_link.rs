//! One-click "Copy link" for a file, used by the tray popover's upload rows,
//! and "Create link" in a capture's Insights panel.
//!
//! The Drive's Share dialog asks how long a link should live and whether it
//! needs a password; a quick action cannot ask anything, so this command
//! settles both the way the capture card's automatic link does: a public link
//! that lasts until it is revoked. Before minting it looks for the file's live
//! link, by the same rule the Captures page uses to show one
//! ([`link_belongs_to_file`]): one this device made for the file's path, or,
//! for a capture, one made elsewhere (the web console, the browser extension,
//! another computer) from a file of the same name and size. That link is
//! copied again, so a press never makes a second public link and a second
//! full upload billed against the plan's storage.
//!
//! Minting goes through the same two funnels the Share dialog uses
//! (`share_synced_file` for a file on disk, `create_remote_share_inner` for a
//! cloud-only one), so the eligibility gate, the share-origin sidecar (the
//! Drive's "Shared" badge) and the owner wrap all apply unchanged.

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::error::{AppError, Result};
use crate::shares::SqliteShareKeystore;
use crate::shares::client::build_account_client;
use crate::shares::commands::{ShareChoice, ShareLink, console_base_url};
use crate::shares::insights::LinkSettings;
use crate::shares::origin::{self, ShareOrigin};
use crate::shares::preview::is_capture_name;
use chrono::{DateTime, Duration, Utc};
use hcfs_client::client::share::{ShareSecret, ShareTtl, build_share_url_for};
use serde::Serialize;
use tauri::AppHandle;
use tracing::{info, warn};

/// What the popover shows after a press. A failure is an `Ok` outcome with a
/// sentence written here, so the webview never words a share error itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum QuickLinkOutcome {
    /// The link is on the clipboard. `reused` is true when it was an existing
    /// link rather than a new one.
    #[serde(rename_all = "camelCase")]
    Copied { url: String, reused: bool },
    /// Nothing was copied; `message` says why, in the user's terms.
    Failed { message: String },
}

/// Copy offered when the link exists but the clipboard refused it.
pub const NOT_COPIED: &str = "The link was made, but it couldn't be copied. Open Shared Links to copy it.";

/// An existing link to the file, as far as this device can see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExistingLink {
    pub share_token: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    /// The rebuilt URL, `None` when this device does not hold the key.
    pub url: Option<String>,
    pub is_private: bool,
}

/// A link that expires within this margin is not worth handing out: the
/// recipient would open it after it died.
const MIN_REMAINING: Duration = Duration::hours(1);

/// The newest link worth copying again: public (a password link copied
/// without its password is useless, and the password is never stored), not
/// about to expire, and rebuildable on this device.
#[must_use]
pub fn pick_reusable(links: &[ExistingLink], now: DateTime<Utc>) -> Option<String> {
    pick_reusable_link(links, now).and_then(|l| l.url.clone())
}

/// [`pick_reusable`], with the whole link: its token too.
#[must_use]
pub fn pick_reusable_link(links: &[ExistingLink], now: DateTime<Utc>) -> Option<&ExistingLink> {
    links
        .iter()
        .filter(|l| !l.is_private)
        .filter(|l| l.expires_at.is_none_or(|e| e > now + MIN_REMAINING))
        .filter(|l| l.url.is_some())
        .max_by_key(|l| l.created_at)
}

/// Create link in Insights, when the capture's links could not be read: no
/// link is made, since that is how a capture ends up with two public,
/// never-expiring links and a second full upload.
pub const LINKS_UNREADABLE: &str = "Couldn't check whether this capture already has a link. Try again.";

/// Copy link, when the file's links could not be read: nothing is made, for
/// the same reason as [`LINKS_UNREADABLE`].
pub const FILE_LINKS_UNREADABLE: &str = "Couldn't check whether this file already has a link. Try again.";

/// The file already has a live link, but this device holds no key to rebuild
/// its address (it was made on another device that never shared its key).
/// Making a second one here would be the duplicate this module exists to
/// prevent, so the user is told where a new one can be made on purpose.
pub const LINK_NOT_ON_THIS_DEVICE: &str =
    "This file already has a link made on another device, and it can't be copied here. Use Share via link to make a new one.";

/// What to do about a file's links before a quick link is handed out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reuse<'a> {
    /// Copy this link again.
    Link(&'a ExistingLink),
    /// A live link exists that this device cannot rebuild: make nothing.
    NotOnThisDevice,
    /// The file has no live link worth handing out: make one.
    Mint,
}

/// The single decision both quick actions (the tray's Copy link and Create
/// link in Insights) take: the newest reusable link ([`pick_reusable_link`]),
/// else refuse when a live, not about to expire link exists that this device
/// holds no key for, else mint. A password link this device knows about is
/// not a reason to refuse: it cannot be handed out without its password, so
/// a public one is made, as before.
#[must_use]
pub fn decide_reuse(links: &[ExistingLink], now: DateTime<Utc>) -> Reuse<'_> {
    if let Some(link) = pick_reusable_link(links, now) {
        return Reuse::Link(link);
    }
    let keyless_live = links
        .iter()
        .any(|l| l.url.is_none() && l.expires_at.is_none_or(|e| e > now + MIN_REMAINING));
    if keyless_live { Reuse::NotOnThisDevice } else { Reuse::Mint }
}

/// The extensions the Captures page treats as a screenshot or a recording:
/// the image and video groups of the frontend's `getFileTypeFromExtension`.
const CAPTURE_MEDIA_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "tiff", "tif", "heic", "heif", "avif", "raw", "mp4", "mov", "mkv", "webm", "3gp", "ogg",
];

fn is_capture_media(file_name: &str) -> bool {
    file_name
        .rsplit_once('.')
        .is_some_and(|(_, ext)| CAPTURE_MEDIA_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// The last part of a drive-relative path.
fn base_name(relative_path: &str) -> &str {
    let trimmed = relative_path.trim_matches('/');
    trimmed.rsplit_once('/').map_or(trimmed, |(_, name)| name)
}

/// Whether a listed link belongs to the file at `(folder_label,
/// relative_path)`. The same rule as the frontend's `captureSharesFrom`, the
/// one every surface that shows a file's link uses, so a row that shows a
/// link icon and its Copy link always agree:
///
/// - a link this device made (`origin` is its `share_origin` row) belongs to
///   the file it was made for;
/// - a link with no origin here was made elsewhere, and the server names its
///   file by name and size only. It belongs to a screenshot or recording
///   whose name is a capture's own (`is_capture_name`, which carries the
///   second it was taken) and matches, unless both sizes are known and
///   differ. Any other file gets only this device's links: a plain
///   `image.png` must not pick up another file's link.
#[must_use]
pub fn link_belongs_to_file(
    origin: Option<&ShareOrigin>,
    link_filename: &str,
    link_size: u64,
    folder_label: &str,
    relative_path: &str,
    size: Option<u64>,
) -> bool {
    if let Some(o) = origin {
        return o.folder_label == folder_label && same_relative_path(&o.relative_path, relative_path);
    }
    let name = base_name(relative_path);
    let sizes_agree = match size {
        Some(s) if s > 0 && link_size > 0 => s == link_size,
        _ => true,
    };
    is_capture_media(name) && is_capture_name(name) && link_filename == name && sizes_agree
}

/// Two drive-relative paths name the same file. The server stores some paths
/// with a leading slash and the sidecar stores whatever the minting surface
/// passed, so the comparison ignores leading and trailing slashes.
#[must_use]
pub fn same_relative_path(a: &str, b: &str) -> bool {
    a.trim_matches('/') == b.trim_matches('/')
}

/// The sentence for a mint that failed: a refusal Rust already worded (a
/// `Validation`) is shown as is, anything else gets the capture card's link
/// copy, so a transport error's own text never reaches the user.
#[must_use]
pub fn failure_copy(e: &AppError) -> String {
    match e {
        AppError::Validation(message) => message.clone(),
        other => crate::capture::deliver::link_failure_copy(other),
    }
}

/// The file's links that the server still lists ([`link_belongs_to_file`]),
/// with their addresses rebuilt where this device holds (or can recover from
/// the owner wrap) the key. `size` is the file's size when the caller knows
/// it. A listing failure is an error, and callers make nothing on it.
async fn existing_links(state: &AppState, account_id: &str, folder_label: &str, relative_path: &str, size: Option<u64>) -> Result<Vec<ExistingLink>> {
    let pool = state.pool()?;
    let client = build_account_client(pool, account_id).await?;
    let summaries = client.list_shares().await.map_err(|e| AppError::Hcfs(format!("list_shares: {e}")))?;
    let tokens: Vec<&str> = summaries.iter().map(|s| s.share_token.as_str()).collect();
    let owner = account_key(account_id);
    let origins = origin::fetch_for_tokens(pool, &owner, &tokens).await?;
    let matching: Vec<&str> = summaries
        .iter()
        .filter(|s| {
            link_belongs_to_file(
                origins.get(&s.share_token),
                &s.filename,
                s.plaintext_size,
                folder_label,
                relative_path,
                size,
            )
        })
        .map(|s| s.share_token.as_str())
        .collect();
    if matching.is_empty() {
        return Ok(Vec::new());
    }
    let keystore = SqliteShareKeystore::new(pool.clone());
    let mut keys = keystore
        .get_many(&matching)
        .map_err(|e| AppError::Hcfs(format!("keystore lookup: {e}")))?;
    super::owner_wrap::sync_file_wraps(state, account_id, &keystore, &mut keys, &matching).await;
    let console_base = console_base_url();
    Ok(summaries
        .iter()
        .filter(|s| matching.contains(&s.share_token.as_str()))
        .map(|s| {
            let secret = keys.get(&s.share_token);
            ExistingLink {
                share_token: s.share_token.clone(),
                created_at: s.created_at,
                expires_at: s.expires_at,
                // `Err` only for a folder-link secret, which no file token holds.
                url: secret.and_then(|secret| build_share_url_for(&console_base, &s.share_token, secret).ok()),
                is_private: secret.is_some_and(ShareSecret::is_private),
            }
        })
        .collect())
}

/// Mint a public, never-expiring link through the Share dialog's funnels.
async fn mint(state: &AppState, account_id: &str, folder_label: &str, relative_path: &str, file_id: Option<&str>) -> Result<ShareLink> {
    match file_id {
        Some(id) => {
            crate::shares::commands::create_remote_share_inner(
                state,
                account_id,
                folder_label,
                relative_path,
                id,
                ShareTtl::Never,
                ShareChoice::Public,
                None,
                // The tray's one-click copy sends no chat preview: there is no
                // switch in front of it to say whether the user wants one.
                None,
            )
            .await
        }
        None => {
            crate::shares::commands::share_synced_file(state, account_id, folder_label, relative_path, ShareTtl::Never, ShareChoice::Public, None)
                .await
        }
    }
}

/// Reuse the file's link or make one, then put it on the clipboard.
///
/// `file_id` is the server file id, passed only for a file with no copy on
/// this device (the Drive's `isCloudOnlyRow`); such a file is shared the way
/// the Share dialog shares it, from a temporary decrypted copy. `size` is the
/// file's size when the row knows it, so a capture's link made elsewhere is
/// matched as the row's link icon matches it.
///
/// A link is made only when the file truly has none ([`decide_reuse`]): its
/// links could not be read, or it has one this device cannot copy, and
/// nothing is made.
///
/// # Errors
///
/// Only for an invalid request (blank drive or path) or no signed-in account;
/// a link that could not be made or copied is a `Failed` outcome.
#[tauri::command]
pub async fn copy_file_share_link(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    folder_label: String,
    relative_path: String,
    file_id: Option<String>,
    size: Option<u64>,
) -> Result<QuickLinkOutcome> {
    let folder_label = folder_label.trim().to_owned();
    let relative_path = relative_path.trim().trim_matches('/').to_owned();
    if folder_label.is_empty() || relative_path.is_empty() {
        return Err(AppError::Validation("This file can't be shared from here.".into()));
    }
    let file_id = file_id.map(|id| id.trim().to_owned()).filter(|id| !id.is_empty());
    let account_id = state.current_account_id()?;

    let existing = match existing_links(&state, &account_id, &folder_label, &relative_path, size).await {
        Ok(links) => links,
        Err(e) => {
            warn!(error = %e, "could not look for an existing link; making none");
            return Ok(QuickLinkOutcome::Failed {
                message: FILE_LINKS_UNREADABLE.into(),
            });
        }
    };
    let (url, reused) = match decide_reuse(&existing, Utc::now()) {
        Reuse::Link(link) => (link.url.clone().unwrap_or_default(), true),
        Reuse::NotOnThisDevice => {
            info!("quick link: the file's link was made elsewhere and has no key here; making none");
            return Ok(QuickLinkOutcome::Failed {
                message: LINK_NOT_ON_THIS_DEVICE.into(),
            });
        }
        Reuse::Mint => match mint(&state, &account_id, &folder_label, &relative_path, file_id.as_deref()).await {
            Ok(link) => (link.share_url, false),
            Err(e) => {
                warn!(error = %e, cloud_only = file_id.is_some(), "quick link could not be made");
                return Ok(QuickLinkOutcome::Failed { message: failure_copy(&e) });
            }
        },
    };
    info!(reused, "quick link ready");

    use tauri_plugin_clipboard_manager::ClipboardExt;
    if let Err(e) = app.clipboard().write_text(url.clone()) {
        warn!(error = %e, "quick link made but not copied");
        return Ok(QuickLinkOutcome::Failed { message: NOT_COPIED.into() });
    }
    Ok(QuickLinkOutcome::Copied { url, reused })
}

/// What "Create link" in a capture's Insights panel made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureLink {
    pub share_token: String,
    pub share_url: String,
    /// The link is on the clipboard, as the capture card's "Create link" leaves it.
    pub copied: bool,
    /// Its Insights, Comments and Reactions were asked for but could not be
    /// turned on (the plan or the server could not be asked, or the request
    /// failed), so the link has them off. The panel says so rather than
    /// leaving the owner to find the switches off.
    pub switches_not_sent: bool,
    /// The capture already had a link this device can hand out, and that link
    /// was given again rather than a second one made.
    pub reused: bool,
}

/// What a link made from the Insights panel asks for: what every capture
/// link gets, Settings' "Track views, comments and reactions"
/// (`insights::for_capture`). The plan rule still decides
/// (`insights::apply_after_mint` passes them through `within_plan`), so a
/// free plan's link starts with them off, as every new link on that plan does.
#[must_use]
pub const fn insights_panel_link_settings(captures_default: bool) -> LinkSettings {
    crate::shares::insights::for_capture(captures_default)
}

/// An existing link handed out again: copied, as a new one would be.
fn reused_capture_link(app: &AppHandle, link: &ExistingLink, url: String) -> CaptureLink {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let copied = app.clipboard().write_text(url.clone()).is_ok();
    CaptureLink {
        share_token: link.share_token.clone(),
        share_url: url,
        copied,
        switches_not_sent: false,
        reused: true,
    }
}

/// "Create link" in the Insights panel of a capture that has no link yet:
/// a public link that lasts until it is revoked, made through the same
/// funnels as the tray's Copy link (so the storage gate, the share-origin
/// row that matches it to the capture's row and the owner wrap all apply),
/// then its switches, then its chat preview when Settings asks for one, as
/// the capture card's "Create link" does.
///
/// The panel offers this only when the capture shows no link, but that can be
/// because the listing it read was stale or failed. So the capture's links
/// are looked up first: one this device can hand out is given again, and a
/// lookup that fails makes nothing (`LINKS_UNREADABLE`), since a second
/// public, never-expiring link and a second full upload is the cost of
/// guessing wrong.
///
/// The switches are sent before this returns, unlike after other mints, so
/// the panel that opens on the new link reads them on rather than racing the
/// request. The link is copied too; a refused clipboard is not a failure.
///
/// # Errors
///
/// A blank drive or path, no signed-in account, a lookup of the capture's
/// links that failed, or a link that could not be made, in Rust's sentence
/// (`failure_copy`).
#[tauri::command]
pub async fn create_capture_link(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    folder_label: String,
    relative_path: String,
    file_id: Option<String>,
    size: Option<u64>,
) -> Result<CaptureLink> {
    let folder_label = folder_label.trim().to_owned();
    let relative_path = relative_path.trim().trim_matches('/').to_owned();
    if folder_label.is_empty() || relative_path.is_empty() {
        return Err(AppError::Validation("This capture can't get a link from here.".into()));
    }
    let file_id = file_id.map(|id| id.trim().to_owned()).filter(|id| !id.is_empty());
    let account_id = state.current_account_id()?;

    let existing = match existing_links(&state, &account_id, &folder_label, &relative_path, size).await {
        Ok(links) => links,
        Err(e) => {
            warn!(error = %e, "capture link: could not look for an existing link; making none");
            return Err(AppError::Validation(LINKS_UNREADABLE.into()));
        }
    };
    match decide_reuse(&existing, Utc::now()) {
        Reuse::Link(found) => {
            if let Some(url) = found.url.clone() {
                info!("capture link from Insights: reusing the capture's link");
                return Ok(reused_capture_link(&app, found, url));
            }
        }
        Reuse::NotOnThisDevice => return Err(AppError::Validation(LINK_NOT_ON_THIS_DEVICE.into())),
        Reuse::Mint => {}
    }

    let link = match mint(&state, &account_id, &folder_label, &relative_path, file_id.as_deref()).await {
        Ok(link) => link,
        Err(e) => {
            warn!(error = %e, cloud_only = file_id.is_some(), "capture link could not be made from Insights");
            return Err(AppError::Validation(failure_copy(&e)));
        }
    };
    let wanted = insights_panel_link_settings(crate::shares::insights::captures_default(&state).await);
    let switches = crate::shares::insights::apply_after_mint(&state, &account_id, &link.share_token, wanted).await;
    // A preview is drawn from the file on this computer; a cloud-only
    // capture has none here, so it gets no preview, as from the tray.
    if file_id.is_none() {
        let source = crate::capture::deliver::LinkSource::Synced {
            label: folder_label.clone(),
            rel_path: relative_path.clone(),
        };
        crate::capture::deliver::spawn_preview_if_wanted(&app, &state, &account_id, &source, &link.share_token).await;
    }
    info!("capture link made from Insights");

    use tauri_plugin_clipboard_manager::ClipboardExt;
    let copied = app.clipboard().write_text(link.share_url.clone()).is_ok();
    Ok(CaptureLink {
        share_token: link.share_token,
        share_url: link.share_url,
        copied,
        switches_not_sent: switches == crate::shares::insights::AfterMint::NotSent,
        reused: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(age_hours: i64, expires_in_hours: Option<i64>, url: Option<&str>, is_private: bool) -> ExistingLink {
        let now = Utc::now();
        ExistingLink {
            share_token: format!("tok-{}", url.unwrap_or("none")),
            created_at: now - Duration::hours(age_hours),
            expires_at: expires_in_hours.map(|h| now + Duration::hours(h)),
            url: url.map(str::to_owned),
            is_private,
        }
    }

    #[test]
    fn reuses_the_newest_public_link_this_device_can_rebuild() {
        let links = [
            link(48, None, Some("old"), false),
            link(1, None, Some("new"), false),
            link(5, Some(100), Some("middle"), false),
        ];
        assert_eq!(pick_reusable(&links, Utc::now()).as_deref(), Some("new"));
    }

    #[test]
    fn never_reuses_a_password_link() {
        // The password is never stored, so the copied link could not be opened.
        let links = [link(1, None, Some("private"), true)];
        assert_eq!(pick_reusable(&links, Utc::now()), None);
    }

    #[test]
    fn skips_a_link_this_device_holds_no_key_for() {
        let links = [link(1, None, None, false), link(9, None, Some("rebuildable"), false)];
        assert_eq!(pick_reusable(&links, Utc::now()).as_deref(), Some("rebuildable"));
    }

    #[test]
    fn skips_a_link_about_to_expire() {
        let now = Utc::now();
        let dying = ExistingLink {
            share_token: "dying".into(),
            created_at: now,
            expires_at: Some(now + Duration::minutes(10)),
            url: Some("dying".into()),
            is_private: false,
        };
        let expired = ExistingLink {
            share_token: "expired".into(),
            created_at: now,
            expires_at: Some(now - Duration::minutes(1)),
            url: Some("expired".into()),
            is_private: false,
        };
        assert_eq!(pick_reusable(&[dying, expired], now), None);
        assert_eq!(pick_reusable(&[link(1, Some(48), Some("alive"), false)], now).as_deref(), Some("alive"));
    }

    /// A link made from the Insights panel follows Settings' "Track views,
    /// comments and reactions" like every capture link, and the plan rule
    /// still gives the free plan's link none, as for any new link.
    #[test]
    fn the_insights_panels_link_follows_the_settings_choice_within_the_plan() {
        use crate::shares::insights::within_plan;
        assert_eq!(insights_panel_link_settings(true), LinkSettings::all(true));
        assert_eq!(
            insights_panel_link_settings(false),
            LinkSettings::all(false),
            "tracking turned off in Settings"
        );
        assert_eq!(within_plan(insights_panel_link_settings(true), Some(true)), LinkSettings::all(true));
        assert_eq!(within_plan(insights_panel_link_settings(true), Some(false)), LinkSettings::all(false));
        assert_eq!(within_plan(insights_panel_link_settings(true), None), LinkSettings::all(false));
    }

    /// Create link in Insights gives the capture's existing link again, with
    /// its token, rather than making a second one.
    #[test]
    fn the_reused_link_is_the_newest_public_one_with_its_token() {
        let links = [
            link(48, None, Some("old"), false),
            link(1, None, Some("new"), false),
            link(0, None, Some("pw"), true),
        ];
        let found = pick_reusable_link(&links, Utc::now()).expect("a link to reuse");
        assert_eq!(found.share_token, "tok-new");
        assert_eq!(found.url.as_deref(), Some("new"));
    }

    /// The Insights panel reads `shareToken` and `copied` off this.
    #[test]
    fn capture_link_wire_shape_is_camel_case() {
        let link = CaptureLink {
            share_token: "t".into(),
            share_url: "u".into(),
            copied: true,
            switches_not_sent: false,
            reused: true,
        };
        assert_eq!(
            serde_json::to_value(&link).expect("serialises"),
            serde_json::json!({ "shareToken": "t", "shareUrl": "u", "copied": true, "switchesNotSent": false, "reused": true })
        );
    }

    fn origin(label: &str, path: &str) -> ShareOrigin {
        ShareOrigin {
            folder_label: label.into(),
            relative_path: path.into(),
        }
    }

    const CAPTURE: &str = "Recording 2026-10-30 at 11.09.18.mp4";

    /// A link made in the web console (no origin on this device) belongs to
    /// the capture of the same name, wherever it sits in the drive: the case
    /// where the tray used to mint a second link and a second upload.
    #[test]
    fn a_link_made_elsewhere_belongs_to_the_capture_of_that_name() {
        let path = format!("Captures/{CAPTURE}");
        assert!(link_belongs_to_file(None, CAPTURE, 320_870, "hippius-captures", &path, Some(320_870)));
        assert!(
            link_belongs_to_file(None, CAPTURE, 320_870, "hippius-captures", CAPTURE, None),
            "size unknown"
        );
        assert!(
            link_belongs_to_file(None, CAPTURE, 0, "hippius-captures", CAPTURE, Some(5)),
            "link size unknown"
        );
    }

    #[test]
    fn a_link_made_elsewhere_from_a_different_file_does_not_belong() {
        assert!(
            !link_belongs_to_file(None, CAPTURE, 999, "hippius-captures", CAPTURE, Some(320_870)),
            "same name, different size: a different file"
        );
        assert!(
            !link_belongs_to_file(None, "image.png", 10, "Drive", "image.png", Some(10)),
            "a plain name is not specific enough to match by name"
        );
        assert!(
            !link_belongs_to_file(
                None,
                "Screenshot 2026-10-30 at 11.58.27.txt",
                10,
                "Drive",
                "Screenshot 2026-10-30 at 11.58.27.txt",
                None
            ),
            "only a screenshot or a recording"
        );
        assert!(!link_belongs_to_file(
            None,
            "Recording 2026-10-30 at 11.09.19.mp4",
            10,
            "d",
            CAPTURE,
            None
        ));
    }

    /// A link this device made belongs to the path it was made for, and only
    /// that path: the name rule is never consulted for it.
    #[test]
    fn a_link_made_here_belongs_to_its_own_path_only() {
        let here = origin("Drive", "/Captures/a.png");
        assert!(link_belongs_to_file(Some(&here), "a.png", 1, "Drive", "Captures/a.png", None));
        assert!(!link_belongs_to_file(Some(&here), "a.png", 1, "Other", "Captures/a.png", None));
        let other = origin("hippius-captures", "Old/Recording 2026-10-30 at 11.09.18.mp4");
        assert!(
            !link_belongs_to_file(Some(&other), CAPTURE, 1, "hippius-captures", CAPTURE, None),
            "made here for another path: not this capture's, even with its name"
        );
    }

    #[test]
    fn reuse_copies_the_live_link_and_mints_only_when_there_is_none() {
        let now = Utc::now();
        let links = [link(1, None, Some("console"), false)];
        assert!(matches!(decide_reuse(&links, now), Reuse::Link(l) if l.url.as_deref() == Some("console")));
        assert_eq!(decide_reuse(&[], now), Reuse::Mint);
        // A password link cannot be handed out without its password: a public
        // one is made, as before.
        assert_eq!(decide_reuse(&[link(1, None, Some("pw"), true)], now), Reuse::Mint);
        // Only dying links: a fresh one is made.
        assert_eq!(decide_reuse(&[link(1, Some(0), Some("dying"), false)], now), Reuse::Mint);
    }

    /// A live link this device holds no key for is still a live link: making
    /// a second one would be the duplicate, so nothing is made.
    #[test]
    fn a_live_link_without_a_key_here_is_never_duplicated() {
        let now = Utc::now();
        assert_eq!(decide_reuse(&[link(1, None, None, false)], now), Reuse::NotOnThisDevice);
        // A reusable link still wins over a keyless one.
        let both = [link(1, None, None, false), link(9, None, Some("here"), false)];
        assert!(matches!(decide_reuse(&both, now), Reuse::Link(l) if l.url.as_deref() == Some("here")));
        // A keyless link about to expire does not block a new one.
        assert_eq!(decide_reuse(&[link(1, Some(0), None, false)], now), Reuse::Mint);
    }

    #[derive(serde::Deserialize)]
    struct CaseFile {
        label: String,
        path: String,
        size: Option<u64>,
    }
    #[derive(serde::Deserialize)]
    struct CaseOrigin {
        label: String,
        path: String,
    }
    #[derive(serde::Deserialize)]
    struct CaseLink {
        filename: String,
        size: u64,
        origin: Option<CaseOrigin>,
    }
    #[derive(serde::Deserialize)]
    struct FileLinkCase {
        note: String,
        file: CaseFile,
        link: CaseLink,
        belongs: bool,
    }

    /// The same cases the frontend's `captureSharesFrom` is held to
    /// (`app/lib/utils/__tests__/fileLinks.test.ts`), so the row's link icon
    /// and its Copy link can never disagree about which link is the file's.
    #[test]
    fn link_belongs_to_file_matches_the_shared_fixture() {
        let cases: Vec<FileLinkCase> =
            serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/file_link_cases.json")))
                .expect("file_link_cases.json is valid JSON");
        assert!(!cases.is_empty(), "fixture must carry cases");
        for case in &cases {
            let origin = case.link.origin.as_ref().map(|o| origin(&o.label, &o.path));
            let got = link_belongs_to_file(
                origin.as_ref(),
                &case.link.filename,
                case.link.size,
                &case.file.label,
                &case.file.path,
                case.file.size,
            );
            assert_eq!(got, case.belongs, "{}", case.note);
        }
    }

    #[test]
    fn base_name_is_the_last_path_part() {
        assert_eq!(base_name("/Captures/a.png"), "a.png");
        assert_eq!(base_name("a.png"), "a.png");
    }

    #[test]
    fn no_links_means_mint() {
        assert_eq!(pick_reusable(&[], Utc::now()), None);
    }

    #[test]
    fn paths_match_across_leading_slashes_only() {
        assert!(same_relative_path("/Captures/a.png", "Captures/a.png"));
        assert!(same_relative_path("Captures/a.png", "Captures/a.png/"));
        assert!(!same_relative_path("Captures/a.png", "Captures/b.png"));
        assert!(!same_relative_path("Captures/a.png", "a.png"));
    }

    #[test]
    fn a_worded_refusal_is_shown_as_is_and_transport_text_never_is() {
        assert_eq!(
            failure_copy(&AppError::Validation("File has no usable name".into())),
            "File has no usable name"
        );
        let transport = failure_copy(&AppError::Hcfs(
            "create_share: error sending request: Network unreachable (os error 51)".into(),
        ));
        assert!(!transport.contains("os error"), "{transport}");
        let full = failure_copy(&AppError::NotReady(crate::error::NotReadyKind::StorageLimitReached));
        assert!(!full.is_empty());
    }

    #[test]
    fn outcome_wire_shape_is_tagged_camel_case() {
        let copied = serde_json::to_value(QuickLinkOutcome::Copied {
            url: "https://x/#k=1".into(),
            reused: true,
        })
        .expect("json");
        assert_eq!(copied, serde_json::json!({"status": "copied", "url": "https://x/#k=1", "reused": true}));
        let failed = serde_json::to_value(QuickLinkOutcome::Failed { message: "m".into() }).expect("json");
        assert_eq!(failed, serde_json::json!({"status": "failed", "message": "m"}));
    }
}
