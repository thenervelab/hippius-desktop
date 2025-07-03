use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event, EventKind, event::CreateKind};
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::thread;
use crate::constants::substrate::SYNC_PATH;

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
    // Only log create events (new files or folders)
    if let EventKind::Create(kind) = event.kind {
        match kind {
            CreateKind::File | CreateKind::Folder => {
                for path in event.paths {
                    println!("[FolderSync] New {:?} added: {}", kind, path.display());
                }
            }
            _ => {}
        }
    }
}
