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

        // Watch the root directory recursively to get all changes
        watcher.watch(&root_dir, RecursiveMode::Recursive)?;

        // Spawn a task to process raw events and send them through the channel
        let event_sender_clone = event_sender.clone();
        let root_dir_clone = root_dir.clone();
        std::thread::spawn(move || {
            let mut processed_events = HashSet::new();
            
            for event in rx {
                // Process events immediately instead of batching
                if let Some(paths) = Self::process_event(&event, &root_dir_clone) {
                    for (path, is_dir, is_create) in paths {
                        let event_key = (path.clone(), is_dir, is_create);
                        
                        // Deduplicate events to avoid processing the same event multiple times
                        if !processed_events.contains(&event_key) {
                            processed_events.insert(event_key.clone());
                            
                            let fs_event = if is_create {
                                FsEvent::Create(path.clone(), is_dir)
                            } else {
                                FsEvent::Remove(path.clone(), is_dir)
                            };
                            
                            if let Err(e) = event_sender_clone.send(fs_event) {
                                error!("Failed to send FS event: {}", e);
                            } else {
                                info!("[FsWatcher] Sent event for: {:?}", path.file_name());
                            }
                            
                            // Clear processed events periodically to avoid memory growth
                            if processed_events.len() > 1000 {
                                processed_events.clear();
                            }
                        }
                    }
                }
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
        
        info!("[FsWatcher] Processing event: {:?}", event.kind);

        // Process create/remove/rename events
        match &event.kind {
            EventKind::Create(_) => {
                info!("[FsWatcher] Create event detected");
                for path in &event.paths {
                    // Check if the path is within our root directory
                    if path.starts_with(root_dir) {
                        let is_dir = path.is_dir();
                        info!("[FsWatcher] Create: {:?} (is_dir: {})", 
                            path.file_name().and_then(|n| n.to_str()), 
                            is_dir
                        );
                        result.push((path.clone(), is_dir, true));
                    }
                }
            },
            EventKind::Remove(_) => {
                info!("[FsWatcher] Remove event detected");
                for path in &event.paths {
                    // Check if the path was within our root directory
                    if path.starts_with(root_dir) {
                        // For remove events, we can't check is_dir() as the file is gone
                        // So we'll use the best guess based on the path
                        let is_dir = path.to_string_lossy().ends_with(std::path::MAIN_SEPARATOR) || 
                                   path.extension().is_none();
                        
                        info!("[FsWatcher] Remove: {:?} (is_dir: {})", 
                            path.file_name().and_then(|n| n.to_str()), 
                            is_dir
                        );
                        result.push((path.clone(), is_dir, false));
                    }
                }
            },
            EventKind::Modify(notify::event::ModifyKind::Name(rename_type)) => {
                info!("[FsWatcher] Rename event detected: {:?}", rename_type);
                
                // For rename events, we get both old and new paths in the event
                let paths: Vec<_> = event.paths.iter().collect();
                
                // A rename should have exactly 2 paths: [from, to]
                if paths.len() == 2 {
                    let (from_path, to_path) = (&paths[0], &paths[1]);
                    
                    // Check if this is actually a delete (file moved to outside watched directory)
                    let from_in_watched = from_path.starts_with(root_dir);
                    let to_in_watched = to_path.starts_with(root_dir);
                    
                    if from_in_watched && !to_in_watched {
                        // This is a delete (file moved outside watched directory)
                        let is_dir = from_path.is_dir();
                        info!("[FsWatcher] Delete detected (moved outside): {:?} (is_dir: {})", 
                            from_path.file_name().and_then(|n| n.to_str()),
                            is_dir
                        );
                        result.push((from_path.to_path_buf(), is_dir, false));
                    } else if !from_in_watched && to_in_watched {
                        // This is a create (file moved into watched directory)
                        let is_dir = to_path.is_dir();
                        info!("[FsWatcher] Create detected (moved inside): {:?} (is_dir: {})", 
                            to_path.file_name().and_then(|n| n.to_str()),
                            is_dir
                        );
                        result.push((to_path.to_path_buf(), is_dir, true));
                    } else if from_in_watched && to_in_watched {
                        // This is a proper rename within the same directory
                        let is_dir = to_path.is_dir() || from_path.is_dir();
                        
                        info!("[FsWatcher] Rename within directory: {:?} -> {:?} (is_dir: {})", 
                            from_path.file_name().and_then(|n| n.to_str()),
                            to_path.file_name().and_then(|n| n.to_str()),
                            is_dir
                        );
                        
                        // Add remove for old path
                        result.push((from_path.to_path_buf(), is_dir, false));
                        // Add create for new path
                        result.push((to_path.to_path_buf(), is_dir, true));
                    }
                } else {
                    // Fallback for unexpected number of paths - treat as individual events
                    for path in paths {
                        if path.starts_with(root_dir) {
                            let is_dir = path.is_dir();
                            info!("[FsWatcher] Fallback handling for: {:?} (is_dir: {})", 
                                path.file_name().and_then(|n| n.to_str()), 
                                is_dir
                            );
                            // We can't determine if this is create or remove, so we'll check if the file exists
                            if path.exists() {
                                result.push((path.clone(), is_dir, true));
                            } else {
                                result.push((path.clone(), is_dir, false));
                            }
                        }
                    }
                }
            },
            _ => {
                info!("[FsWatcher] Ignoring event: {:?}", event.kind);
                return None;
            }
        }
        
        if result.is_empty() {
            None
        } else {
            Some(result)
        }
    }
    
    pub fn get_root_dir(&self) -> &Path {
        &self.root_dir
    }
}