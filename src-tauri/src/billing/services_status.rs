//! Per-product state for the signed-in account, from the one endpoint that
//! spans every product.
//!
//! `GET /api/services/status/` is what the web console reads to decide
//! whether a product needs the user's attention, and this is the same call
//! with the same shape. Reading it here rather than deriving a status from
//! the Drive subscription payload is the point: the console and the
//! desktop then say the same thing about the same account, and a state the
//! desktop has not been taught about still arrives.

use serde::{Deserialize, Serialize};

use crate::api::client::ApiClient;
use crate::app_state::AppState;
use crate::error::Result;

/// The path is the console's `SERVICES_STATUS_PATH`, unchanged.
const SERVICES_STATUS_PATH: &str = "/api/services/status/";

/// What Drive says about itself.
///
/// Every field is optional deliberately: the endpoint gained products over
/// time and will gain more, and a client that fails on an unfamiliar
/// payload is worse than one that shows what it understands.
#[derive(Deserialize, Serialize, Debug, Default, Clone, PartialEq)]
// Serialize-only rename: the API sends snake_case (`plan_name`,
// `managed_by`) and the frontend expects camelCase. Renaming BOTH
// directions is the trap — the field names would stop matching the wire
// and every optional field would quietly deserialize to None, leaving a
// status that parses fine and says nothing.
#[serde(rename_all(serialize = "camelCase"))]
pub struct DriveServiceStatus {
    /// `none` | `pending` | `active` | `past_due` | `canceled`, as the API
    /// spells them. Kept as a string rather than an enum so a state added
    /// server-side reaches the frontend instead of failing to parse.
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub plan_name: Option<String>,
    /// `console` | `stripe` | `app_store` | `play_store`. A plan bought on
    /// another rail cannot be fixed from here, so the UI sends the user
    /// where it can be rather than to a button that would fail.
    #[serde(default)]
    pub managed_by: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
struct ServicesStatusPayload {
    #[serde(default)]
    drive: Option<DriveServiceStatus>,
}

/// Drive's state for the signed-in account.
///
/// **Fails quiet**, like the console's own hook: this drives a banner about
/// billing, so an outage here should leave the page as it was rather than
/// putting an error in front of someone who came to do something else. An
/// unreachable endpoint returns the default (no state), which renders
/// nothing.
#[tauri::command]
pub async fn get_drive_service_status(state: tauri::State<'_, AppState>, account_id: String) -> Result<DriveServiceStatus> {
    let account_id = state.require_session_account_typed(&account_id)?;
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());

    match client.get::<ServicesStatusPayload>(SERVICES_STATUS_PATH, &account_id).await {
        Ok(payload) => Ok(payload.drive.unwrap_or_default()),
        Err(e) => {
            tracing::warn!(error = %e, "services status unavailable; drive banner suppressed");
            Ok(DriveServiceStatus::default())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The desktop must not narrow the API's vocabulary: a state added
    /// server-side has to reach the frontend, not fail to parse and take
    /// the whole payload with it.
    #[test]
    fn an_unfamiliar_state_still_parses() {
        let payload: ServicesStatusPayload = serde_json::from_value(serde_json::json!({
            "drive": { "state": "some_future_state", "plan_name": "Plus" },
            "hub": { "state": "active" },
        }))
        .expect("an unfamiliar drive state parses");
        let drive = payload.drive.expect("drive is present");

        assert_eq!(drive.state.as_deref(), Some("some_future_state"));
        assert_eq!(drive.plan_name.as_deref(), Some("Plus"));
    }

    /// An account with no Drive row at all is not an error.
    #[test]
    fn a_payload_without_drive_is_empty_not_broken() {
        let payload: ServicesStatusPayload =
            serde_json::from_value(serde_json::json!({ "s3": { "state": "active" } })).expect("a payload with no drive parses");
        assert!(payload.drive.is_none());
    }

    /// The console reads snake_case off the wire; the desktop re-serializes
    /// camelCase for its own frontend, and the two must not be confused.
    #[test]
    fn the_wire_is_snake_case_in_and_camel_case_out() {
        let payload: ServicesStatusPayload = serde_json::from_value(serde_json::json!({
            "drive": { "state": "canceled", "plan_name": "Plus", "managed_by": "stripe" },
        }))
        .expect("snake_case parses");
        let drive = payload.drive.expect("drive is present");
        assert_eq!(drive.managed_by.as_deref(), Some("stripe"));

        let out = serde_json::to_value(&drive).expect("serializes");
        assert_eq!(out.get("planName").and_then(|v| v.as_str()), Some("Plus"));
        assert_eq!(out.get("managedBy").and_then(|v| v.as_str()), Some("stripe"));
    }
}
