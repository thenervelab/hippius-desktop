use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event, EventKind, event::CreateKind, event::ModifyKind};
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::thread;
use crate::constants::substrate::{SYNC_PATH};
use crate::constants::ipfs::{API_URL};
use crate::commands::ipfs_commands::{encrypt_and_upload_file};
use crate::utils::file_operations::delete_and_unpin_user_file_records_by_name;
use tauri::async_runtime::block_on; // To run async in sync context
use std::fs;

const DEFAULT_K: usize = 3;
const DEFAULT_M: usize = 5;
const DEFAULT_CHUNK_SIZE: usize = 1024 * 1024;

pub fn start_folder_sync(account_id: String) {
    let sync_path = PathBuf::from(SYNC_PATH);
    let account_id = account_id.clone(); // Only clone here for thread move

    // Spawn a thread so the watcher doesn't block the main async runtime
    thread::spawn(move || {
        let (tx, rx) = channel();

        let mut watcher: RecommendedWatcher = Watcher::new(tx, notify::Config::default())
            .expect("[FolderSync] Failed to create watcher");

        watcher
            .watch(&sync_path, RecursiveMode::Recursive)
            .expect("[FolderSync] Failed to watch sync directory");

        for res in rx {
            match res {
                Ok(event) => handle_event(event, &account_id),
                Err(e) => eprintln!("[FolderSync] Watch error: {:?}", e),
            }
        }
    });
}

fn handle_event(event: Event, account_id: &str) {
    match event.kind {
        EventKind::Create(kind) => {
            for path in event.paths {
                match kind {
                    CreateKind::File => {
                        upload_file(&path, account_id);
                    }
                    CreateKind::Folder => {
                        upload_folder(&path, account_id);
                    }
                    _ => {}
                }
            }
        }
        EventKind::Modify(ModifyKind::Data(_)) => {
            for path in event.paths {
                // clear db and unpin, then upload
                replace_file_and_db_records(&path, account_id);
            }
        }
        _ => {}
    }
}

fn upload_file(path: &Path, account_id: &str) {
    if !path.is_file() {
        return;
    }
    let file_path = path.to_string_lossy().to_string();

    // Call the async upload command in a blocking way
    let result = block_on(encrypt_and_upload_file(
        account_id.to_string(),
        file_path,
        API_URL.to_string(),
        Some(DEFAULT_K),
        Some(DEFAULT_M),
        Some(DEFAULT_CHUNK_SIZE),
    ));

    match result {
        Ok(cid) => println!("[FolderSync] Uploaded file, metadata CID: {}", cid),
        Err(e) => eprintln!("[FolderSync] Upload failed: {}", e),
    }
}

fn upload_folder(folder_path: &Path, account_id: &str) {
    if !folder_path.is_dir() {
        return;
    }
    // Recursively walk the folder and upload each file
    let walker = fs::read_dir(folder_path);
    if let Ok(entries) = walker {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                upload_file(&path, account_id);
            } else if path.is_dir() {
                upload_folder(&path, account_id); // Recursively handle subfolders
            }
        }
    }
}

// New function: replace file and db records
fn replace_file_and_db_records(path: &Path, account_id: &str) {
    if !path.is_file() {
        return;
    }
    // Extract file name
    let file_name = match path.file_name().map(|s| s.to_string_lossy().to_string()) {
        Some(name) => name,
        None => {
            eprintln!("[FolderSync] Could not extract file name from path: {}", path.display());
            return;
        }
    };
    // Delete and unpin old records
    let delete_result = block_on(delete_and_unpin_user_file_records_by_name(&file_name));
    if delete_result.is_ok() {
        // Upload the file only if delete succeeded
        upload_file(path, account_id);
    } else {
        eprintln!("[FolderSync] Failed to delete/unpin old records for '{}', skipping upload.", file_name);
    }
}

#[tauri::command]
pub fn start_folder_sync_tauri(account_id: String) {
    start_folder_sync(account_id);
}