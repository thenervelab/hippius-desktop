use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event, EventKind};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::time::Duration;
use log::{info, error};
use std::collections::HashSet;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Debug)]
pub enum FsEvent {
    Create(PathBuf, bool), 
    Remove(PathBuf, bool), 
}

pub struct FsWatcher {
    _watcher: RecommendedWatcher, 
    root_dir: PathBuf,
    event_sender: UnboundedSender<FsEvent>,
}

impl FsWatcher {
    pub fn new<P: AsRef<Path>>(
        root_dir: P,
        event_sender: UnboundedSender<FsEvent>,
    ) -> notify::Result<Self> {
        let root_dir = root_dir.as_ref().to_path_buf();
        let (tx, rx) = channel();
        
        // Create watcher with debounce to handle rapid file changes
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, _>| {
            if let Ok(event) = res {
                if tx.send(event).is_err() {
                    error!("Failed to send file system event");
                }
            }
        })?;

        // Watch the root directory non-recursively to only get root-level changes
        watcher.watch(&root_dir, RecursiveMode::NonRecursive)?;

        // Spawn a task to process raw events and send them through the channel
        let event_sender_clone = event_sender.clone();
        let root_dir_clone = root_dir.clone();
        std::thread::spawn(move || {
            let mut processed_paths = HashSet::new();
            
            // Process events in batches to handle rapid changes
            let mut batch = Vec::new();
            let mut last_flush = std::time::Instant::now();
            
            for event in rx {
                let now = std::time::Instant::now();
                
                // Filter for create/remove events only at root level
                if let Some(paths) = Self::process_event(&event, &root_dir_clone) {
                    for (path, is_dir, is_create) in paths {
                        let key = (path.clone(), is_dir);
                        
                        // Only process if we haven't seen this path in this batch
                        if !processed_paths.contains(&key) {
                            processed_paths.insert(key);
                            batch.push((path, is_dir, is_create));
                        }
                    }
                }
                
                // Flush batch if enough time has passed or batch is getting large
                if now.duration_since(last_flush) > Duration::from_millis(100) || batch.len() > 50 {
                    Self::process_batch(&batch, &event_sender_clone);
                    batch.clear();
                    processed_paths.clear();
                    last_flush = now;
                }
            }
            
            // Process any remaining events
            if !batch.is_empty() {
                Self::process_batch(&batch, &event_sender_clone);
            }
        });

        Ok(Self {
            _watcher: watcher,
            root_dir,
            event_sender,
        })
    }
    
    fn process_event(event: &Event, root_dir: &Path) -> Option<Vec<(PathBuf, bool, bool)>> {
        let mut result = Vec::new();
        
        println!("[FsWatcher] Processing event: {:?}", event.kind);

        // Process create/remove/rename events
        match &event.kind {
            EventKind::Create(_) => {
                println!("[FsWatcher] Create event detected");
                for path in &event.paths {
                    println!("[FsWatcher] Checking path: {:?}", path);
                    if let Some(parent) = path.parent() {
                        println!("[FsWatcher] Parent: {:?}, Root: {:?}", parent, root_dir);
                        if parent == root_dir {
                            let is_dir = path.is_dir();
                            println!("[FsWatcher] Root-level create: {:?} (is_dir: {})", path.file_name().and_then(|n| n.to_str()), is_dir);
                            result.push((path.clone(), is_dir, true));
                        }
                    }
                }
            },
            EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                println!("[FsWatcher] Remove/Rename event detected");
                for path in &event.paths {
                    println!("[FsWatcher] Checking path for removal: {:?}", path);
                    if let Some(parent) = path.parent() {
                        println!("[FsWatcher] Remove parent: {:?}, Root: {:?}", parent, root_dir);
                        if parent == root_dir {
                            let is_dir = path.to_str().map(|s| s.ends_with(std::path::MAIN_SEPARATOR)).unwrap_or(false);
                            println!("[FsWatcher] Root-level remove: {:?} (is_dir: {})", path.file_name().and_then(|n| n.to_str()), is_dir);
                            result.push((path.clone(), is_dir, false));
                        }
                    }
                }
            },
            _ => {
                println!("[FsWatcher] Ignoring event: {:?}", event.kind);
                return None;
            }
        }
        
        if result.is_empty() {
            None
        } else {
            Some(result)
        }
    }
    
    fn process_batch(batch: &[(PathBuf, bool, bool)], sender: &UnboundedSender<FsEvent>) {
        for (i, (path, is_dir, is_create)) in batch.iter().enumerate() {
            let event = if *is_create {
                FsEvent::Create(path.clone(), *is_dir)
            } else {
                FsEvent::Remove(path.clone(), *is_dir)
            };
            
            if let Err(e) = sender.send(event) {
                error!("Failed to send FS event: {}", e);
            } else {
                println!("[FsWatcher] Successfully sent event {}/{}", i + 1, batch.len());
            }
        }
    }
    
    pub fn get_root_dir(&self) -> &Path {
        &self.root_dir
    }
}