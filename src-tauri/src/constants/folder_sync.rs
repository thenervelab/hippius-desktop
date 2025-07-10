use serde::Serialize;

#[derive(Default)]
pub struct SyncStatus {
    pub total_files: usize,
    pub synced_files: usize,
    pub in_progress: bool,
}

#[derive(serde::Serialize)]
pub struct SyncStatusResponse {
    pub synced_files: usize,
    pub total_files: usize,
    pub in_progress: bool,
    pub percent: f32,
}