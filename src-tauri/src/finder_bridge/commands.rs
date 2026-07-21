//! Tauri IPC commands backing the "decide in the app" Finder share flow.
//!
//! A "Share with Hippius" right-click parks a request in
//! [`crate::app_state::AppState`] and emits `finder:share-choosing` (see
//! [`super::dispatch::handle`]); the app opens its chooser, the user picks
//! Anyone-with-the-link vs Password-protected, and the modal calls
//! [`hcfs_finder_confirm_share`] to mint — or [`hcfs_finder_cancel_share`] if
//! they back out. The renderer round-trips only `{request_id, visibility}`, so a
//! compromised webview can never mint a share of a file it merely names (the
//! path came from Finder and stays server-side).
//!
//! The `finder_bridge` module is `#[cfg(unix)]` (macOS + Linux) because its
//! socket layer uses Unix-domain sockets, so `generate_handler!` in `main.rs`
//! registers these two commands under a matching `#[cfg(unix)]` — they are
//! absent on Windows. The Finder feature itself is macOS-only: off macOS (i.e.
//! on Linux) the bodies are inert, and the FE never invokes them.

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use hcfs_client::client::share::ShareProgress;

use tauri::ipc::Channel;


/// Mint the parked Finder share with the choices the user made. `request_id`
/// is the handle from `finder:share-choosing`; `ttl` is one of the expiry
/// presets and `visibility` is `"public"` or `"private"`, with an optional
/// caller-supplied `password`. `on_progress` streams the encrypt/upload bar.
///
/// A missing `request_id` (the app restarted, or the confirm arrived twice)
/// surfaces as [`AppError::NotFound`] so the modal can tell the user to
/// right-click again rather than showing an opaque failure.
#[tauri::command]
pub async fn hcfs_finder_confirm_share(
    state: tauri::State<'_, AppState>,
    request_id: String,
    ttl: String,
    visibility: String,
    password: Option<String>,
    on_progress: Channel<ShareProgress>,
) -> Result<crate::shares::commands::ShareLink> {
    #[cfg(target_os = "macos")]
    {
        // Validate the untrusted arguments at the boundary, then take the parked
        // request (single-use). `take_finder_share` returns the owned value, so
        // no lock is held across the mint `.await` below (axiom 74).
        //
        // Both parsers are shared with `hcfs_create_share`, so the in-app and
        // Finder entry points cannot diverge on what they accept.
        let ttl = crate::shares::commands::parse_ttl(&ttl)?;
        let choice = crate::shares::commands::ShareChoice::parse(&visibility, password)?;
        let pending = state
            .take_finder_share(&request_id)
            .ok_or_else(|| AppError::NotFound("This share request has expired. Right-click the file and choose Share with Hippius again.".into()))?;
        let progress = crate::shares::commands::share_progress_forwarder(on_progress);
        // Register a cancel handle and run the mint inside a `select!` against it,
        // so a `hcfs_finder_cancel_share` (the modal's Cancel button) DROPS the
        // mint future and aborts its in-flight upload rather than letting a large
        // outside-file / folder-zip upload run to completion unseen (illu L2). The
        // guard removes the handle when this scope ends — on success, error,
        // cancel, OR the command future being dropped (window closed mid-upload).
        let cancel = state.register_finder_mint(&request_id);
        let _guard = FinderMintGuard {
            state: state.inner(),
            request_id: &request_id,
        };
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(AppError::Validation("Share cancelled.".into())),
            minted = crate::finder_bridge::dispatch::mint_confirmed(&state, &pending.path, ttl, choice, Some(progress)) => minted,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&state, request_id, ttl, visibility, password, on_progress);
        // Unreachable from the UI (the FE only invokes this on macOS); a typed
        // Validation rather than the catch-all Other keeps it consistent with the
        // error-taxonomy migration (illu review L4).
        Err(AppError::Validation("Finder sharing is only available on macOS.".into()))
    }
}

/// RAII teardown for an in-flight Finder mint: drops the cancel handle registered
/// by [`hcfs_finder_confirm_share`] when the mint scope ends — whether it
/// completes, errors, is cancelled, or the whole command future is dropped
/// (window closed mid-upload). Paired begin/end teardown via `Drop` is the
/// cancellation-safe way to run cleanup on every exit path (RfR ch. 8
/// §Cancellation; axiom `rust_quality_71_drop_order`).
#[cfg(target_os = "macos")]
struct FinderMintGuard<'a> {
    state: &'a AppState,
    request_id: &'a str,
}

#[cfg(target_os = "macos")]
impl Drop for FinderMintGuard<'_> {
    fn drop(&mut self) {
        self.state.finish_finder_mint(self.request_id);
    }
}

/// Cancel a Finder share when the user dismisses the modal. Covers both stages:
/// drops a still-parked request (the chooser was open, mint not started) AND
/// signals an in-flight mint's cancel token (an upload is running) so it aborts.
/// Idempotent: an already-finished or unknown `request_id` is a no-op.
#[tauri::command]
pub async fn hcfs_finder_cancel_share(state: tauri::State<'_, AppState>, request_id: String) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        state.cancel_finder_share(&request_id);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&state, request_id);
    }
    Ok(())
}


#[cfg(all(test, target_os = "macos"))]
mod tests {
    use crate::shares::commands::ShareLink;
    use std::collections::BTreeSet;

    /// Wire-shape pin for what `hcfs_finder_confirm_share` returns and the FE
    /// `shares.ts` reads. A public share must carry NO `password` key — the FE
    /// keys off its presence to show or hide the password box, so a stray
    /// `password: null` would render an empty password field on a public link.
    #[test]
    fn public_share_link_wire_shape_omits_password() {
        let json = serde_json::to_value(ShareLink {
            share_token: "tok".into(),
            share_url: "https://console.hippius.com/share/tok#k=K".into(),
            expires_at: Some("2026-01-01T00:00:00Z".into()),
            password: None,
        })
        .expect("serialize");
        let keys: BTreeSet<String> = json.as_object().expect("object").keys().cloned().collect();
        let expected: BTreeSet<String> =
            ["expiresAt", "shareToken", "shareUrl"].into_iter().map(String::from).collect();
        assert_eq!(keys, expected, "public ShareLink wire keys drifted");
    }

    /// A private share adds `password` (camelCase, present). This is the only
    /// moment the password is ever available — it is never persisted.
    #[test]
    fn private_share_link_wire_shape_includes_password() {
        let json = serde_json::to_value(ShareLink {
            share_token: "tok".into(),
            share_url: "https://console.hippius.com/share/tok#p=B".into(),
            expires_at: Some("2026-01-01T00:00:00Z".into()),
            password: Some("pw-123".into()),
        })
        .expect("serialize");
        assert_eq!(json["shareToken"], "tok");
        assert_eq!(json["password"], "pw-123");
    }

    /// A never-expiring share serializes `expiresAt` as JSON null rather than
    /// omitting the key, so the FE can distinguish "no expiry" from a missing
    /// field.
    #[test]
    fn never_expiring_share_link_serializes_null_expiry() {
        let json = serde_json::to_value(ShareLink {
            share_token: "tok".into(),
            share_url: "https://console.hippius.com/share/tok#k=K".into(),
            expires_at: None,
            password: None,
        })
        .expect("serialize");
        assert!(json.as_object().expect("object").contains_key("expiresAt"));
        assert!(json["expiresAt"].is_null());
    }
}
