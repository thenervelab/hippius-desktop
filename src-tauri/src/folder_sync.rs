use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event, EventKind, event::CreateKind};
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::thread;
use crate::constants::substrate::{SYNC_PATH, DEFAULT_ACCOUNT_ID};
use crate::constants::ipfs::{API_URL};
use crate::commands::ipfs_commands::encrypt_and_upload_file;
use tauri::async_runtime::block_on; // To run async in sync context
use std::fs;

const DEFAULT_K: usize = 3;
const DEFAULT_M: usize = 5;
const DEFAULT_CHUNK_SIZE: usize = 1024 * 1024;

pub fn start_folder_sync() {
    let sync_path = PathBuf::from(SYNC_PATH);

    // Spawn a thread so the watcher doesn't block the main async runtime
    thread::spawn(move || {
        let (tx, rx) = channel();

        let mut watcher: RecommendedWatcher = Watcher::new(tx, notify::Config::default())
            .expect("[FolderSync] Failed to create watcher");

        watcher
            .watch(&sync_path, RecursiveMode::Recursive)
            .expect("[FolderSync] Failed to watch sync directory");

        println!("[FolderSync] Watching directory: {}", sync_path.display());

        for res in rx {
            match res {
                Ok(event) => handle_event(event),
                Err(e) => eprintln!("[FolderSync] Watch error: {:?}", e),
            }
        }
    });
}

fn handle_event(event: Event) {
    if let EventKind::Create(kind) = event.kind {
        for path in event.paths {
            match kind {
                CreateKind::File => {
                    println!("[FolderSync] New file detected: {}", path.display());
                    upload_file(&path);
                }
                CreateKind::Folder => {
                    println!("[FolderSync] New folder detected: {}", path.display());
                    upload_folder(&path);
                }
                _ => {}
            }
        }
    }
}

fn upload_file(path: &Path) {
    if !path.is_file() {
        return;
    }
    let file_path = path.to_string_lossy().to_string();
    println!("[FolderSync] Uploading file: {}", file_path);

    // Call the async upload command in a blocking way
    let result = block_on(encrypt_and_upload_file(
        DEFAULT_ACCOUNT_ID.to_string(),
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

fn upload_folder(folder_path: &Path) {
    if !folder_path.is_dir() {
        return;
    }
    // Recursively walk the folder and upload each file
    let walker = fs::read_dir(folder_path);
    if let Ok(entries) = walker {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                upload_file(&path);
            } else if path.is_dir() {
                upload_folder(&path); // Recursively handle subfolders
            }
        }
    }
}
