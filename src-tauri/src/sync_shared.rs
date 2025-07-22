use std::sync::{Arc, Mutex};
use std::collections::HashSet;
use once_cell::sync::Lazy;
use once_cell::sync::OnceCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::PathBuf;
use crate::constants::folder_sync::{SyncStatus, SyncStatusResponse};
use tokio::sync::mpsc;

// Global sync status tracking
pub static SYNC_STATUS: Lazy<Arc<Mutex<SyncStatus>>> =
    Lazy::new(|| Arc::new(Mutex::new(SyncStatus::default())));

// Upload lock to prevent concurrent uploads
pub static UPLOAD_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

// Track files currently being uploaded to prevent duplicates
pub static UPLOADING_FILES: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Track accounts currently syncing (account_id + sync_type)
pub static SYNCING_ACCOUNTS: Lazy<Arc<Mutex<HashSet<(String, &'static str)>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Track recently uploaded files to prevent immediate re-processing
pub static RECENTLY_UPLOADED: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Track recently uploaded folders to prevent immediate re-processing
pub static RECENTLY_UPLOADED_FOLDERS: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

// Debounce state for batching create events
pub static CREATE_BATCH: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));
pub static CREATE_BATCH_TIMER_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub struct UploadJob {
    pub account_id: String,
    pub seed_phrase: String,
    pub file_path: String,
}

pub static UPLOAD_SENDER: OnceCell<mpsc::UnboundedSender<UploadJob>> = OnceCell::new();