use crate::user_profile_sync::{start_user_profile_sync_tauri};
use crate::private_folder_sync::start_private_folder_sync_tauri;
use crate::public_folder_sync::start_public_folder_sync_tauri;
use crate::sync_shared::{reset_all_sync_state, prepare_for_new_sync};
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
    
    // First, signal cancellation for any existing sync processes
    reset_all_sync_state();
    
    // Cancel any existing sync tasks
    let mut sync_state = state.sync.lock().await;
    for task in sync_state.tasks.drain(..) {
        task.abort(); // Cancel the previous sync tasks
    }
    
    // Wait a bit for cleanup to complete
    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
    
    // Prepare for new sync (reset cancellation token)
    prepare_for_new_sync();

    // Start new sync tasks
    let app_handle_clone = app.clone();
    let app_handle_folder_sync = app.clone();
    let app_handle_public_folder_sync = app.clone();
    let account_clone = account_id.clone();
    let account_clone2 = account_id.clone();
    let mnemonic_clone = mnemonic.clone();
    
    let user_profile_task = tokio::spawn(async move {
        start_user_profile_sync_tauri(app_handle_clone, account_clone).await;
    });
    
    let folder_task = tokio::spawn(async move {
        start_private_folder_sync_tauri(app_handle_folder_sync, account_id, mnemonic).await;
    });

    let public_folder_task =  tokio::spawn(async move {
        start_public_folder_sync_tauri(app_handle_public_folder_sync, account_clone2, mnemonic_clone).await;
    });
    
    // Store the task handles
    sync_state.tasks.push(user_profile_task);
    sync_state.tasks.push(public_folder_task);
    sync_state.tasks.push(folder_task);
    
    Ok(())
}

#[tauri::command]
pub async fn cleanup_sync(app: tauri::AppHandle) -> Result<(), String> {
    println!("Cleaning up sync processes...");
    
    // Signal global cancellation first
    reset_all_sync_state();
    
    let state = app.state::<Arc<AppState>>();
    let mut sync_state = state.sync.lock().await;
    
    // Abort all tasks
    for task in sync_state.tasks.drain(..) {
        task.abort();
    }
    
    // Wait for cleanup to complete
    tokio::time::sleep(tokio::time::Duration::from_millis(2000)).await;
    
    println!("Sync cleanup completed");
    Ok(())
}