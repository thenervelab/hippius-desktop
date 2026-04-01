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
        }
    }
}

/// Serialize `AppError` for Tauri IPC.
///
/// Produces `{ "kind": "Db", "message": "..." }` so the frontend
/// can match on `kind` programmatically and display `message` to users.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
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

/// Bridge from the existing [`crate::api_client_logic::ApiError`] type.
impl From<crate::api_client_logic::ApiError> for AppError {
    fn from(err: crate::api_client_logic::ApiError) -> Self {
        match err {
            crate::api_client_logic::ApiError::Http { status, body } => {
                Self::Api { status, body }
            }
            crate::api_client_logic::ApiError::Other(msg) => Self::Other(msg),
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
        assert!(json["message"]
            .as_str()
            .expect("message str")
            .contains("Sync setup"));
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
        assert!(
            display.contains("not found"),
            "should contain body: {display}"
        );
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
        let io_err =
            std::io::Error::new(std::io::ErrorKind::NotFound, "gone");
        let app_err = AppError::from(io_err);
        assert!(matches!(app_err, AppError::Io(_)));
        assert!(app_err.to_string().contains("gone"));
    }

    #[test]
    fn poison_error_converts_via_from() {
        let mutex = std::sync::Mutex::new(42);
        // Poison the mutex
        let _ =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
        let api_err = crate::api_client_logic::ApiError::Http {
            status: 502,
            body: "bad gateway".into(),
        };
        let app_err = AppError::from(api_err);
        assert!(matches!(
            app_err,
            AppError::Api {
                status: 502,
                body: _
            }
        ));
    }

    #[test]
    fn api_error_bridge_other() {
        let api_err =
            crate::api_client_logic::ApiError::Other("timeout".into());
        let app_err = AppError::from(api_err);
        assert!(
            matches!(app_err, AppError::Other(ref s) if s == "timeout")
        );
    }
}
