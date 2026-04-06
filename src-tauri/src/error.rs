use serde::Serialize;

/// Unified error type for the Hippius desktop backend.
///
/// All Tauri IPC commands return `Result<T, AppError>`. The error is
/// serialized as JSON for the frontend, preserving the `kind` field
/// for programmatic matching and `message` for display.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Blockchain RPC error: {0}")]
    Substrate(String),

    #[error("HCFS client error: {0}")]
    Hcfs(String),

    #[error("VPN error: {0}")]
    Nebula(String),

    #[error("Cryptography error: {0}")]
    Crypto(String),

    #[error("API error (HTTP {status}): {body}")]
    Api { status: u16, body: String },

    #[error("{0}")]
    Validation(String),

    #[error("Authentication error: {0}")]
    Auth(String),

    #[error("{0}")]
    NotReady(NotReadyKind),

    #[error("Progress error: {0}")]
    Progress(String),

    #[error("Lock poisoned: {0}")]
    Lock(String),

    #[error("{0}")]
    Other(String),
}

/// Machine-readable error kinds for state precondition failures.
/// The frontend can match on these structurally instead of
/// pattern-matching English error strings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NotReadyKind {
    /// Sync setup required before this operation can proceed.
    SyncSetup,
    /// Drive not initialized — needs first-time setup.
    DriveNotInitialized,
    /// Drive is not unlocked — needs password/mnemonic.
    DriveNotUnlocked,
    /// A sync operation is currently in progress.
    SyncInProgress,
    /// No encryption key available for this drive.
    NoEncryptionKey,
    /// HCFS config not found — sync not configured.
    ConfigMissing,
    /// Master mnemonic could not be recovered from any source
    /// (in-memory cache, disk, drive, or DB). User must re-login.
    MasterMnemonicUnrecoverable,
    /// Not enough disk space to complete the operation.
    NotEnoughDiskSpace,
}

impl std::fmt::Display for NotReadyKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SyncSetup => write!(f, "Sync setup required"),
            Self::DriveNotInitialized => write!(f, "Drive not initialized"),
            Self::DriveNotUnlocked => write!(f, "Drive is not unlocked"),
            Self::SyncInProgress => {
                write!(f, "Sync is in progress, please wait")
            }
            Self::NoEncryptionKey => {
                write!(f, "No encryption key available")
            }
            Self::ConfigMissing => {
                write!(f, "HCFS config not found. Please set up sync first.")
            }
            Self::MasterMnemonicUnrecoverable => {
                write!(
                    f,
                    "Master mnemonic could not be recovered. Please log out and log back in with your seed phrase."
                )
            }
            Self::NotEnoughDiskSpace => {
                write!(f, "Not enough disk space to complete this operation.")
            }
        }
    }
}

/// Serialize `AppError` for Tauri IPC.
///
/// Produces `{ "kind": "Db", "message": "..." }` so the frontend
/// can match on `kind` programmatically and display `message` to users.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        let kind = match self {
            Self::Db(_) => "Db",
            Self::Io(_) => "Io",
            Self::Http(_) => "Http",
            Self::Json(_) => "Json",
            Self::Substrate(_) => "Substrate",
            Self::Hcfs(_) => "Hcfs",
            Self::Nebula(_) => "Nebula",
            Self::Crypto(_) => "Crypto",
            Self::Api { .. } => "Api",
            Self::Validation(_) => "Validation",
            Self::Auth(_) => "Auth",
            Self::NotReady(_) => "NotReady",
            Self::Progress(_) => "Progress",
            Self::Lock(_) => "Lock",
            Self::Other(_) => "Other",
        };
        s.serialize_field("kind", kind)?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

// Tauri 2 has a blanket `impl<T: Serialize> From<T> for InvokeError`,
// so `AppError` is automatically usable as a command error type via the
// `Serialize` impl above — no explicit `From` impl needed.

/// Project-wide result type alias. Every Tauri command and most
/// async helpers return this.
pub type Result<T> = std::result::Result<T, AppError>;

/// Bridge: accept existing `Result<_, String>` into `AppError`.
impl From<String> for AppError {
    fn from(s: String) -> Self {
        Self::Other(s)
    }
}

/// Bridge: accept `&str` errors.
impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        Self::Other(s.to_string())
    }
}

/// Convenience for mutex lock poisoning.
impl<T> From<std::sync::PoisonError<T>> for AppError {
    fn from(e: std::sync::PoisonError<T>) -> Self {
        Self::Lock(e.to_string())
    }
}

/// Bridge: accept `Box<dyn Error>` (returned by hcfs-client, zip, etc.).
impl From<Box<dyn std::error::Error>> for AppError {
    fn from(e: Box<dyn std::error::Error>) -> Self {
        Self::Other(e.to_string())
    }
}

/// Bridge: accept `Box<dyn Error + Send + Sync>`.
impl From<Box<dyn std::error::Error + Send + Sync>> for AppError {
    fn from(e: Box<dyn std::error::Error + Send + Sync>) -> Self {
        Self::Other(e.to_string())
    }
}

/// Bridge from the existing [`crate::api::client::ApiError`] type.
impl From<crate::api::client::ApiError> for AppError {
    fn from(err: crate::api::client::ApiError) -> Self {
        match err {
            crate::api::client::ApiError::Http { status, body } => Self::Api { status, body },
            crate::api::client::ApiError::Other(msg) => Self::Other(msg),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_other_error_has_kind_and_message() {
        let err = AppError::Other("test error".into());
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "Other");
        assert_eq!(json["message"], "test error");
    }

    #[test]
    fn serialize_not_ready_has_kind_and_message() {
        let err = AppError::NotReady(NotReadyKind::SyncSetup);
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "NotReady");
        assert!(json["message"].as_str().expect("message str").contains("Sync setup"));
    }

    #[test]
    fn from_string_produces_other() {
        let err = AppError::from("hello".to_string());
        assert!(matches!(err, AppError::Other(ref s) if s == "hello"));
    }

    #[test]
    fn from_str_produces_other() {
        let err = AppError::from("world");
        assert!(matches!(err, AppError::Other(ref s) if s == "world"));
    }

    #[test]
    fn display_validation_is_message_only() {
        let err = AppError::Validation("bad input".into());
        assert_eq!(err.to_string(), "bad input");
    }

    #[test]
    fn display_api_error_includes_status() {
        let err = AppError::Api {
            status: 404,
            body: "not found".into(),
        };
        let display = err.to_string();
        assert!(display.contains("404"), "should contain status: {display}");
        assert!(display.contains("not found"), "should contain body: {display}");
    }

    #[test]
    fn serialize_api_error_has_kind_api() {
        let err = AppError::Api {
            status: 500,
            body: "internal".into(),
        };
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "Api");
    }

    #[test]
    fn not_ready_kind_serializes_screaming_snake() {
        let kind = NotReadyKind::DriveNotInitialized;
        let json = serde_json::to_value(&kind).expect("serialize");
        assert_eq!(json, "DRIVE_NOT_INITIALIZED");
    }

    #[test]
    fn io_error_converts_via_from() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "gone");
        let app_err = AppError::from(io_err);
        assert!(matches!(app_err, AppError::Io(_)));
        assert!(app_err.to_string().contains("gone"));
    }

    #[test]
    fn poison_error_converts_via_from() {
        let mutex = std::sync::Mutex::new(42);
        // Poison the mutex
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = mutex.lock().expect("lock");
            panic!("intentional");
        }));
        let lock_result = mutex.lock();
        assert!(lock_result.is_err());
        let app_err = AppError::from(lock_result.unwrap_err());
        assert!(matches!(app_err, AppError::Lock(_)));
    }

    #[test]
    fn api_error_bridge_http() {
        let api_err = crate::api::client::ApiError::Http {
            status: 502,
            body: "bad gateway".into(),
        };
        let app_err = AppError::from(api_err);
        assert!(matches!(app_err, AppError::Api { status: 502, body: _ }));
    }

    #[test]
    fn api_error_bridge_other() {
        let api_err = crate::api::client::ApiError::Other("timeout".into());
        let app_err = AppError::from(api_err);
        assert!(matches!(app_err, AppError::Other(ref s) if s == "timeout"));
    }

    // ── From impls for remaining types ──────────────────────────────

    #[test]
    fn json_error_converts_via_from() {
        let json_err: serde_json::Error = serde_json::from_str::<String>("not valid json").unwrap_err();
        let app_err = AppError::from(json_err);
        assert!(matches!(app_err, AppError::Json(_)));
        assert!(app_err.to_string().contains("JSON error"), "display: {app_err}",);
    }

    #[test]
    fn box_dyn_error_converts_to_other() {
        let boxed: Box<dyn std::error::Error> = Box::new(std::io::Error::other("oops"));
        let app_err = AppError::from(boxed);
        assert!(matches!(app_err, AppError::Other(_)));
        assert!(app_err.to_string().contains("oops"));
    }

    #[test]
    fn box_dyn_error_send_sync_converts_to_other() {
        let boxed: Box<dyn std::error::Error + Send + Sync> = Box::new(std::io::Error::other("boom"));
        let app_err = AppError::from(boxed);
        assert!(matches!(app_err, AppError::Other(_)));
        assert!(app_err.to_string().contains("boom"));
    }

    // ── NotReadyKind round-trip through JSON ────────────────────────

    #[test]
    fn not_ready_kind_all_variants_serialize_screaming_snake() {
        let cases = [
            (NotReadyKind::SyncSetup, "SYNC_SETUP"),
            (NotReadyKind::DriveNotInitialized, "DRIVE_NOT_INITIALIZED"),
            (NotReadyKind::DriveNotUnlocked, "DRIVE_NOT_UNLOCKED"),
            (NotReadyKind::SyncInProgress, "SYNC_IN_PROGRESS"),
            (NotReadyKind::NoEncryptionKey, "NO_ENCRYPTION_KEY"),
            (NotReadyKind::ConfigMissing, "CONFIG_MISSING"),
            (NotReadyKind::MasterMnemonicUnrecoverable, "MASTER_MNEMONIC_UNRECOVERABLE"),
            (NotReadyKind::NotEnoughDiskSpace, "NOT_ENOUGH_DISK_SPACE"),
        ];
        for (kind, expected) in cases {
            let json = serde_json::to_value(&kind).expect("serialize");
            assert_eq!(json, expected, "variant {kind:?} should serialize to {expected}",);
        }
    }

    // ── Display for every variant ───────────────────────────────────

    #[test]
    fn display_db_error_has_prefix() {
        // SQLx ColumnNotFound is the easiest error to construct without a DB.
        let err = AppError::Db(sqlx::Error::ColumnNotFound("test_col".into()));
        let msg = err.to_string();
        assert!(msg.starts_with("Database error:"), "got: {msg}");
        assert!(msg.contains("test_col"), "got: {msg}");
    }

    #[test]
    fn display_io_error_has_prefix() {
        let err = AppError::Io(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "no access"));
        assert!(err.to_string().starts_with("I/O error:"), "got: {err}",);
    }

    #[test]
    fn display_substrate_error() {
        let err = AppError::Substrate("rpc timeout".into());
        assert_eq!(err.to_string(), "Blockchain RPC error: rpc timeout");
    }

    #[test]
    fn display_hcfs_error() {
        let err = AppError::Hcfs("sync failed".into());
        assert_eq!(err.to_string(), "HCFS client error: sync failed");
    }

    #[test]
    fn display_nebula_error() {
        let err = AppError::Nebula("vpn down".into());
        assert_eq!(err.to_string(), "VPN error: vpn down");
    }

    #[test]
    fn display_crypto_error() {
        let err = AppError::Crypto("bad key".into());
        assert_eq!(err.to_string(), "Cryptography error: bad key");
    }

    #[test]
    fn display_auth_error() {
        let err = AppError::Auth("expired token".into());
        assert_eq!(err.to_string(), "Authentication error: expired token");
    }

    #[test]
    fn display_progress_error() {
        let err = AppError::Progress("tracker fail".into());
        assert_eq!(err.to_string(), "Progress error: tracker fail");
    }

    #[test]
    fn display_lock_error() {
        let err = AppError::Lock("mutex poisoned".into());
        assert_eq!(err.to_string(), "Lock poisoned: mutex poisoned");
    }

    #[test]
    fn display_not_ready_shows_kind_message() {
        let err = AppError::NotReady(NotReadyKind::SyncInProgress);
        assert_eq!(err.to_string(), "Sync is in progress, please wait");
    }

    #[test]
    fn display_other_is_passthrough() {
        let err = AppError::Other("raw message".into());
        assert_eq!(err.to_string(), "raw message");
    }

    // ── Tauri IPC serialization structure ────────────────────────────

    #[test]
    fn serialize_every_variant_has_kind_and_message() {
        let variants: Vec<AppError> = vec![
            AppError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "missing")),
            AppError::Json(serde_json::from_str::<String>("bad").unwrap_err()),
            AppError::Substrate("rpc".into()),
            AppError::Hcfs("sync".into()),
            AppError::Nebula("vpn".into()),
            AppError::Crypto("key".into()),
            AppError::Api {
                status: 403,
                body: "forbidden".into(),
            },
            AppError::Validation("invalid".into()),
            AppError::Auth("unauth".into()),
            AppError::NotReady(NotReadyKind::ConfigMissing),
            AppError::Progress("tracker".into()),
            AppError::Lock("poisoned".into()),
            AppError::Other("misc".into()),
        ];
        let expected_kinds = [
            "Io",
            "Json",
            "Substrate",
            "Hcfs",
            "Nebula",
            "Crypto",
            "Api",
            "Validation",
            "Auth",
            "NotReady",
            "Progress",
            "Lock",
            "Other",
        ];

        for (err, expected_kind) in variants.iter().zip(expected_kinds.iter()) {
            let json = serde_json::to_value(err).expect("serialize");
            assert_eq!(json["kind"], *expected_kind, "wrong kind for {err:?}");
            assert!(json["message"].is_string(), "missing message for {err:?}");
            assert!(!json["message"].as_str().unwrap().is_empty(), "empty message for {err:?}");
        }
    }

    // ── NotReadyKind Display ────────────────────────────────────────

    #[test]
    fn not_ready_kind_display_all_variants() {
        let cases = [
            (NotReadyKind::SyncSetup, "Sync setup required"),
            (NotReadyKind::DriveNotInitialized, "Drive not initialized"),
            (NotReadyKind::DriveNotUnlocked, "Drive is not unlocked"),
            (NotReadyKind::SyncInProgress, "Sync is in progress, please wait"),
            (NotReadyKind::NoEncryptionKey, "No encryption key available"),
            (NotReadyKind::ConfigMissing, "HCFS config not found. Please set up sync first."),
            (
                NotReadyKind::MasterMnemonicUnrecoverable,
                "Master mnemonic could not be recovered. Please log out and log back in with your seed phrase.",
            ),
            (
                NotReadyKind::NotEnoughDiskSpace,
                "Not enough disk space to complete this operation.",
            ),
        ];
        for (kind, expected) in cases {
            assert_eq!(kind.to_string(), expected);
        }
    }
}
