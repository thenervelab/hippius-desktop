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
//! These commands are registered under `#[cfg(unix)]` in `main.rs` and their
//! real bodies run on macOS + Linux (both drive the same Unix-socket bridge).
//! On Windows they are absent (registration gated) and the `#[cfg(not(unix))]`
//! arm is an inert typed error until the Windows native shim (COM DLL) ships.

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use hcfs_client::client::share::ShareProgress;
use serde::Serialize;
use tauri::ipc::Channel;

/// Result of a confirmed Finder share, returned to the modal. A superset of
/// `ShareLink`: a password-protected ("private") share also carries the randomly
/// generated `password` the recipient needs. `password` is omitted from the JSON
/// for a public link (the FE distinguishes the two by its presence).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinderShareCreated {
    share_token: String,
    share_url: String,
    expires_at: String,
    /// `Some` only for a `#p=` (password-protected) share. Omitted from the JSON
    /// for a public `#k=` share.
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
}

impl FinderShareCreated {
    /// A public (`#k=`) share carries no password. macOS-only: its sole caller is
    /// the Finder mint path.
    #[cfg(unix)]
    pub(crate) fn public(link: crate::shares::commands::ShareLink) -> Self {
        Self {
            share_token: link.share_token,
            share_url: link.share_url,
            expires_at: link.expires_at,
            password: None,
        }
    }

    /// A private (`#p=`) share carries the generated password the recipient needs
    /// out-of-band. macOS-only.
    #[cfg(unix)]
    pub(crate) fn private(private: crate::shares::commands::PrivateShare) -> Self {
        Self {
            share_token: private.link.share_token,
            share_url: private.link.share_url,
            expires_at: private.link.expires_at,
            password: Some(private.password),
        }
    }
}

/// The access the user chose in the app's share chooser. A closed enum (not a
/// bool or raw string) so the mint path matches exhaustively and an unknown wire
/// value is rejected once, at the boundary, rather than re-checked downstream
/// (axiom `rust_api_axiom_25_validate_boundary`). macOS-only — the only consumer
/// is the Finder confirm command's macOS body.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShareVisibility {
    /// "Anyone with the link" — a public `#k=` share.
    Public,
    /// "Password protected" — a `#p=` share wrapped under a generated password.
    Private,
}

#[cfg(unix)]
impl ShareVisibility {
    /// Parse the untrusted `visibility` IPC argument into the typed choice,
    /// rejecting anything else with [`AppError::Validation`]. The two accepted
    /// tokens mirror the FE `SegmentedControl` option values (`"public"` /
    /// `"private"`).
    pub(crate) fn parse(raw: &str) -> Result<Self> {
        match raw {
            "public" => Ok(Self::Public),
            "private" => Ok(Self::Private),
            other => Err(AppError::Validation(format!("Unknown share visibility: {other}"))),
        }
    }
}

/// Mint the parked Finder share with the visibility the user chose. `request_id`
/// is the handle from `finder:share-choosing`; `visibility` is `"public"` or
/// `"private"`; `on_progress` streams the encrypt/upload bar. Returns the link
/// (and, for a private share, the password).
///
/// A missing `request_id` (the app restarted, or the confirm arrived twice)
/// surfaces as [`AppError::NotFound`] so the modal can tell the user to
/// right-click again rather than showing an opaque failure.
#[tauri::command]
pub async fn hcfs_finder_confirm_share(
    state: tauri::State<'_, AppState>,
    request_id: String,
    visibility: String,
    on_progress: Channel<ShareProgress>,
) -> Result<FinderShareCreated> {
    #[cfg(unix)]
    {
        // Validate the untrusted visibility at the boundary, then take the parked
        // request (single-use). `take_finder_share` returns the owned value, so
        // no lock is held across the mint `.await` below (axiom 74).
        let visibility = ShareVisibility::parse(&visibility)?;
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
            minted = crate::finder_bridge::dispatch::mint_confirmed(&state, &pending.path, visibility, Some(progress)) => minted,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (&state, request_id, visibility, on_progress);
        // Unreachable from the UI (the command isn't registered off unix); a typed
        // Validation rather than the catch-all Other keeps it consistent with the
        // error-taxonomy migration (illu review L4).
        Err(AppError::Validation("Shell sharing is not available on this platform yet.".into()))
    }
}

/// RAII teardown for an in-flight Finder mint: drops the cancel handle registered
/// by [`hcfs_finder_confirm_share`] when the mint scope ends — whether it
/// completes, errors, is cancelled, or the whole command future is dropped
/// (window closed mid-upload). Paired begin/end teardown via `Drop` is the
/// cancellation-safe way to run cleanup on every exit path (RfR ch. 8
/// §Cancellation; axiom `rust_quality_71_drop_order`).
#[cfg(unix)]
struct FinderMintGuard<'a> {
    state: &'a AppState,
    request_id: &'a str,
}

#[cfg(unix)]
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
    #[cfg(unix)]
    {
        state.cancel_finder_share(&request_id);
    }
    #[cfg(not(unix))]
    {
        let _ = (&state, request_id);
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn visibility_parses_known_tokens() {
        assert_eq!(ShareVisibility::parse("public").expect("public"), ShareVisibility::Public);
        assert_eq!(ShareVisibility::parse("private").expect("private"), ShareVisibility::Private);
    }

    #[test]
    fn visibility_rejects_unknown_token_as_validation() {
        // Anything the FE didn't send must be a typed Validation error, not a
        // silent default to public (which would leak a private-intent share).
        for bad in ["", "Public", "PRIVATE", "anyone", "protected", " public "] {
            let err = ShareVisibility::parse(bad).expect_err("must reject");
            assert!(matches!(err, AppError::Validation(_)), "{bad:?} → {err:?}");
        }
    }

    fn sample_link() -> crate::shares::commands::ShareLink {
        crate::shares::commands::ShareLink {
            share_token: "tok".into(),
            share_url: "https://console.hippius.com/share/tok#k=K".into(),
            expires_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    /// Wire-shape pin for the command return the FE `shares.ts` reads as
    /// `FinderShareCreated`. A public share carries exactly the `ShareLink` keys
    /// (camelCase) and NO `password` (the `skip_serializing_if` must hold — the
    /// FE keys off `password`'s presence to show/hide the password box).
    #[test]
    fn finder_share_created_public_wire_shape() {
        use std::collections::BTreeSet;
        let json = serde_json::to_value(FinderShareCreated::public(sample_link())).expect("serialize");
        let keys: BTreeSet<String> = json.as_object().expect("object").keys().cloned().collect();
        let expected: BTreeSet<String> = ["expiresAt", "shareToken", "shareUrl"].into_iter().map(String::from).collect();
        assert_eq!(
            keys, expected,
            "public FinderShareCreated wire keys drifted (FE shares.ts reads shareToken/shareUrl/expiresAt, no password)"
        );
    }

    /// A private share adds `password` (camelCase, present).
    #[test]
    fn finder_share_created_private_wire_shape_includes_password() {
        let created = FinderShareCreated::private(crate::shares::commands::PrivateShare {
            link: sample_link(),
            password: "pw-123".into(),
        });
        let json = serde_json::to_value(created).expect("serialize");
        assert_eq!(json["shareToken"], "tok");
        assert_eq!(
            json["password"], "pw-123",
            "private FinderShareCreated must carry the password key the FE renders"
        );
    }
}
