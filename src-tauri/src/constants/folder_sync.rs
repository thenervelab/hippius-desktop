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

pub const DEFAULT_K: usize = 3;
pub const DEFAULT_M: usize = 5;
pub const DEFAULT_CHUNK_SIZE: usize = 1024 * 1024;