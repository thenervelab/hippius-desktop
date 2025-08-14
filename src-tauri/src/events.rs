use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct AppEvent {
    pub event_type: String, // e.g., "error", "status_update"
    pub message: String,
    pub details: Option<String>,
}
