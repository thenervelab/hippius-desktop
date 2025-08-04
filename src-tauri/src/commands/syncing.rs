
use crate::user_profile_sync::{start_user_profile_sync_tauri};
use crate::folder_sync::start_folder_sync_tauri;
use crate::public_folder_sync::start_public_folder_sync_tauri;
use tauri::Manager;
use tokio::sync::Mutex;
use std::sync::Arc;

#[derive(Default)]
pub struct SyncState {
    pub tasks: Vec<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
pub struct AppState {
    pub sync: Mutex<SyncState>,
}

#[tauri::command]
pub async fn initialize_sync(
    app: tauri::AppHandle,
    account_id: String,
    mnemonic: String,
) -> Result<(), String> {
    let state = app.state::<Arc<AppState>>();
    
    // Cancel any existing sync tasks
    let mut sync_state = state.sync.lock().await;
    for task in sync_state.tasks.drain(..) {
        task.abort(); // Cancel the previous sync tasks
    }

    // Start new sync tasks
    let account_clone = account_id.clone();
    let account_clone2 = account_id.clone();
    let mnemonic_clone = mnemonic.clone();
    
    let user_profile_task = tokio::spawn(async move {
        start_user_profile_sync_tauri(account_clone).await;
    });
    
    let folder_task = tokio::spawn(async move {
        start_folder_sync_tauri(account_id, mnemonic).await;
    });

    let public_folder_task =  tokio::spawn(async move {
        start_public_folder_sync_tauri(account_clone2, mnemonic_clone).await;
    });
    
    // Store the task handles
    sync_state.tasks.push(user_profile_task);
    sync_state.tasks.push(public_folder_task);
    sync_state.tasks.push(folder_task);
    
    Ok(())
}

#[tauri::command]
pub async fn cleanup_sync(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<AppState>>();
    let mut sync_state = state.sync.lock().await;
    
    for task in sync_state.tasks.drain(..) {
        task.abort();
    }
    
    Ok(())
}