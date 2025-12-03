use crate::private_folder_sync::start_private_folder_sync_tauri;
use crate::public_folder_sync::start_public_folder_sync_tauri;
use crate::sync_engine::DeletePolicy;
use crate::sync_shared::{prepare_for_new_sync, reset_all_sync_state, stop_sync_for_scope};
use crate::utils::sync::{get_private_sync_path, get_public_sync_path};
use base64 as b64;
use serde::{Deserialize, Serialize};
use sodiumoxide::crypto::secretbox;
use sodiumoxide::crypto::secretbox::{Key as SbKey, Nonce as SbNonce};
use sp_core::Pair;
use sp_core::sr25519;
use sqlx;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep};

#[tauri::command]
pub async fn stop_sync_for_scope_command(scope: String) -> Result<(), String> {
    println!("[StopSync] Stopping sync for scope: {}", scope);

    // Validate scope
    if scope != "public" && scope != "private" {
        return Err(format!(
            "Invalid scope: {}. Must be 'public' or 'private'",
            scope
        ));
    }

    // Call the shared function to stop sync for the specified scope
    stop_sync_for_scope(&scope);

    println!("[StopSync] Successfully stopped sync for scope: {}", scope);
    Ok(())
}

#[derive(Default)]
pub struct SyncState {
    pub tasks: Vec<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
pub struct AppState {
    pub sync: Mutex<SyncState>,
}

#[allow(deprecated)]
pub async fn ensure_aws_env(account_id: String, _mnemonic: String) {
    // New flow: prefer stored master token for S3 access. Keep params for compatibility.
    match crate::utils::objectstore_tokens::ensure_master_token_env().await {
        Ok(_) => {
            println!("[Auth] Loaded AWS creds from stored master token");
        }
        Err(e) => {
            eprintln!(
                "[Auth] No master token available for S3 auth (account_id:{}): {}",
                account_id, e
            );
        }
    }
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
        task.abort();
    }

    // Wait a bit for cleanup to complete
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    // Prepare for new sync (reset cancellation token)
    prepare_for_new_sync();

    // Offload heavy subaccount resolution and task spawning to a background task
    let app_for_bg = app.clone();
    let account_for_bg = account_id.clone();
    let mnemonic_for_bg = mnemonic.clone();
    let parent_task = tokio::spawn(async move {
        // Spawn sync tasks
        let app_handle_folder_sync = app_for_bg.clone();
        let app_handle_public_folder_sync = app_for_bg.clone();
        let account_clone2 = account_for_bg.clone();
        let account_clone3 = account_for_bg.clone();
        let mnemonic_clone = mnemonic_for_bg.clone();

        // let user_profile_task = tokio::spawn(async move {
        //     start_user_profile_sync_tauri(app_handle_clone, account_clone).await;
        // });

        // Check DB-configured sync paths and only spawn tasks if present
        let private_enabled = match get_private_sync_path().await {
            Ok(p) if !p.trim().is_empty() => true,
            _ => {
                println!(
                    "[SyncInit] No private sync path configured; skipping private folder sync task"
                );
                false
            }
        };

        let public_enabled = match get_public_sync_path().await {
            Ok(p) if !p.trim().is_empty() => true,
            _ => {
                println!(
                    "[SyncInit] No public sync path configured; skipping public folder sync task"
                );
                false
            }
        };

        // Only perform AWS credentials setup if at least one sync is enabled
        ensure_aws_env(account_for_bg.clone(), mnemonic_for_bg.clone()).await;

        let folder_task = if private_enabled {
            let delete_policy = match get_sync_policy_from_db().await {
                Ok(policy) => policy,
                Err(e) => {
                    eprintln!(
                        "[SyncInit] Failed to get delete policy: {}. Using default UploadOnly.",
                        e
                    );
                    DeletePolicy::UploadOnly
                }
            };

            Some(tokio::spawn(async move {
                start_private_folder_sync_tauri(
                    app_handle_folder_sync,
                    account_for_bg,
                    mnemonic_for_bg,
                    delete_policy,
                )
                .await;
            }))
        } else {
            None
        };

        let public_folder_task = if public_enabled {
            let delete_policy = match get_sync_policy_from_db().await {
                Ok(policy) => policy,
                Err(e) => {
                    eprintln!(
                        "[SyncInit] Failed to get delete policy: {}. Using default UploadOnly.",
                        e
                    );
                    DeletePolicy::UploadOnly
                }
            };

            Some(tokio::spawn(async move {
                start_public_folder_sync_tauri(
                    app_handle_public_folder_sync,
                    account_clone2,
                    mnemonic_clone,
                    delete_policy,
                )
                .await;
            }))
        } else {
            None
        };

        // Record task handles into global AppState so cleanup can abort them
        let state = app_for_bg.state::<Arc<AppState>>();
        let mut guard = state.sync.lock().await;
        // guard.tasks.push(user_profile_task);
        if let Some(handle) = public_folder_task {
            guard.tasks.push(handle);
        }
        if let Some(handle) = folder_task {
            guard.tasks.push(handle);
        }

        // Start S3 inventory cron in background (runs every 30 seconds)
        if let Some(pool) = crate::DB_POOL.get() {
            let pool = pool.clone();
            // Start PUBLIC listing cron only if public sync was started
            if public_enabled {
                let pool_pub = pool.clone();
                let account_for_cron_pub = account_clone3.clone();
                let public_cron_handle = tokio::spawn(async move {
                    let interval = 30u64; // 30 seconds
                    loop {
                        match crate::sync_shared::list_bucket_contents(
                            account_for_cron_pub.clone(),
                            "public".to_string(),
                        )
                        .await
                        {
                            Ok(items) => {
                                if let Err(e) = crate::sync_shared::store_bucket_listing_in_db(
                                    &pool_pub,
                                    &account_for_cron_pub,
                                    "public",
                                    &items,
                                )
                                .await
                                {
                                    eprintln!(
                                        "[S3InventoryCron][public] Failed storing listing: {}",
                                        e
                                    );
                                } else {
                                    println!(
                                        "[S3InventoryCron][public] Stored {} items for {}",
                                        items.len(),
                                        account_for_cron_pub
                                    );
                                }
                            }
                            Err(e) => eprintln!("[S3InventoryCron][public] List failed: {}", e),
                        }

                        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
                    }
                });
                guard.tasks.push(public_cron_handle);
            }

            // Start PRIVATE listing cron only if private sync was started
            if private_enabled {
                let pool_priv = pool.clone();
                let account_for_cron_priv = account_clone3.clone();
                let private_cron_handle = tokio::spawn(async move {
                    let interval = 30u64; // 30 seconds
                    loop {
                        match crate::sync_shared::list_bucket_contents(
                            account_for_cron_priv.clone(),
                            "private".to_string(),
                        )
                        .await
                        {
                            Ok(items) => {
                                if let Err(e) = crate::sync_shared::store_bucket_listing_in_db(
                                    &pool_priv,
                                    &account_for_cron_priv,
                                    "private",
                                    &items,
                                )
                                .await
                                {
                                    eprintln!(
                                        "[S3InventoryCron][private] Failed storing listing: {}",
                                        e
                                    );
                                } else {
                                    println!(
                                        "[S3InventoryCron][private] Stored {} items for {}",
                                        items.len(),
                                        account_for_cron_priv
                                    );
                                }
                            }
                            Err(e) => eprintln!("[S3InventoryCron][private] List failed: {}", e),
                        }

                        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
                    }
                });
                guard.tasks.push(private_cron_handle);
            }
        } else {
            eprintln!("[S3InventoryCron] DB pool unavailable; skipping inventory cron start");
        }
    });

    // Track the parent initialization task and return immediately to avoid blocking login
    sync_state.tasks.push(parent_task);
    Ok(())
}

#[tauri::command]
pub async fn cleanup_sync(app: tauri::AppHandle) -> Result<(), String> {
    println!("[Cleanup] Starting sync cleanup...");

    // Stop all sync processes and reset state
    crate::sync_shared::stop_all_sync_processes();

    // Abort any running tasks
    let state = app.state::<Arc<AppState>>();
    let mut sync_state = state.sync.lock().await;

    if !sync_state.tasks.is_empty() {
        println!(
            "[Cleanup] Aborting {} running tasks...",
            sync_state.tasks.len()
        );
        for task in sync_state.tasks.drain(..) {
            task.abort();
        }

        // Give tasks a moment to handle the abort
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    println!("[Cleanup] Sync cleanup completed");
    Ok(())
}

// Public helper: register an externally spawned task so cleanup_sync can abort it on logout
pub async fn register_task(app: tauri::AppHandle, handle: tokio::task::JoinHandle<()>) {
    let state = app.state::<Arc<AppState>>();
    let mut sync_state = state.sync.lock().await;
    sync_state.tasks.push(handle);
}

// Helper: load first encryption key from DB
pub async fn load_encryption_key(pool: &sqlx::SqlitePool) -> Option<SbKey> {
    match sqlx::query_as::<_, (Vec<u8>,)>("SELECT key FROM encryption_keys ORDER BY id ASC LIMIT 1")
        .fetch_optional(pool)
        .await
    {
        Ok(Some((bytes,))) => {
            if bytes.len() == secretbox::KEYBYTES {
                Some(SbKey::from_slice(&bytes).unwrap())
            } else {
                None
            }
        }
        _ => None,
    }
}

// Helper: encrypt plain text with nonce, return base64 of (nonce || ciphertext)
#[allow(deprecated)]
fn encrypt_phrase(plain: &str, key: &SbKey) -> String {
    let nonce = secretbox::gen_nonce();
    let ct = secretbox::seal(plain.as_bytes(), &nonce, key);
    let mut buf = Vec::with_capacity(secretbox::NONCEBYTES + ct.len());
    buf.extend_from_slice(nonce.as_ref());
    buf.extend_from_slice(&ct);
    b64::encode(&buf)
}

// Helper: try decrypt base64 (nonce||ct), else None
#[allow(deprecated)]
pub fn decrypt_phrase(b64_in: &str, key: &SbKey) -> Option<String> {
    let bytes = b64::decode(b64_in).ok()?;
    if bytes.len() < secretbox::NONCEBYTES {
        return None;
    }
    let (nonce_b, ct) = bytes.split_at(secretbox::NONCEBYTES);
    let nonce = SbNonce::from_slice(nonce_b)?;
    let pt = secretbox::open(ct, &nonce, key).ok()?;
    String::from_utf8(pt).ok()
}

// Helper: heavy logic to resolve or create subaccount seed (non-blocking to UI)
pub async fn resolve_or_create_subaccount_seed(account_id: String, mnemonic: String) -> String {
    // Ensure sodiumoxide is initialized
    let _ = sodiumoxide::init();

    if let Some(pool) = crate::DB_POOL.get() {
        // Load key (required for encrypt/decrypt)
        let maybe_key = load_encryption_key(pool).await;

        match sqlx::query_as::<_, (String,)>(
            "SELECT sub_account_seed_phrase FROM sub_accounts WHERE account_id = ? LIMIT 1",
        )
        .bind(&account_id)
        .fetch_optional(pool)
        .await
        {
            Ok(Some((stored_str,))) => {
                if let Some(key) = &maybe_key {
                    // Try decrypt; if fails, treat as legacy plaintext and migrate
                    if let Some(decrypted) = decrypt_phrase(&stored_str, key) {
                        decrypted
                    } else {
                        stored_str
                    }
                } else {
                    stored_str
                }
            }
            Ok(None) => {
                // Create a new subaccount (sr25519) and store it encrypted
                let (_pair, phrase, _seed) = sr25519::Pair::generate_with_phrase(None);
                let to_store = if let Some(key) = &maybe_key {
                    encrypt_phrase(&phrase, key)
                } else {
                    phrase.clone()
                };

                // Try to register subaccount on-chain; if we get the specific
                // "MainCannotBeSubAccount" error, we will fallback to using the
                // provided mnemonic as the subaccount as well (persisting to DB)
                let mut chosen_seed_for_session = phrase.clone();
                {
                    let main_seed_plain = mnemonic.clone();
                    let sub_seed_plain = phrase.clone();
                    match crate::commands::substrate_tx::add_sub_account_tauri(
                        main_seed_plain,
                        sub_seed_plain,
                    )
                    .await
                    {
                        Ok(msg) => {
                            if let Err(e) = sqlx::query(
                                "INSERT INTO sub_accounts (account_id, sub_account_seed_phrase) VALUES (?, ?)",
                            )
                            .bind(&account_id)
                            .bind(&to_store)
                            .execute(pool)
                            .await
                            {
                                eprintln!(
                                    "[SyncInit] Failed to insert new subaccount for {}: {}",
                                    account_id, e
                                );
                            } else {
                                println!(
                                    "[SyncInit] Stored new subaccount seed phrase for account_id={}",
                                    account_id
                                );
                            };

                            sleep(Duration::from_secs(60)).await;
                            if let Some(key) = &maybe_key {
                                // Try decrypt; if fails, treat as legacy plaintext and migrate
                                if let Some(decrypted) = decrypt_phrase(&to_store, key) {
                                    return decrypted;
                                } else {
                                    return to_store;
                                }
                            } else {
                                return to_store;
                            };

                            println!("[SyncInit] add_sub_account submitted successfully: {}", msg)
                        }
                        Err(err) => {
                            let err_str = err.to_string();
                            eprintln!(
                                "[SyncInit] Failed to submit add_sub_account extrinsic: {}",
                                err_str
                            );
                            if err_str.contains("MainCannotBeSubAccount") {
                                println!(
                                    "[SyncInit] Detected MainCannotBeSubAccount; storing provided mnemonic as subaccount for account_id={}",
                                    account_id
                                );
                                // Encrypt mnemonic if key available, otherwise store plaintext
                                let to_store = if let Some(key) = &maybe_key {
                                    encrypt_phrase(&mnemonic, key)
                                } else {
                                    mnemonic.clone()
                                };
                                if let Err(e) = sqlx::query(
                                    "UPDATE sub_accounts SET sub_account_seed_phrase = ? WHERE account_id = ?"
                                )
                                .bind(&to_store)
                                .bind(&account_id)
                                .execute(pool)
                                .await {
                                    eprintln!("[SyncInit] Failed to update subaccount mnemonic for {}: {}", account_id, e);
                                } else {
                                    println!("[SyncInit] Updated subaccount seed to provided mnemonic for account_id={}", account_id);
                                }
                                // Use mnemonic for this session going forward
                                chosen_seed_for_session = mnemonic.clone();
                            }
                        }
                    }
                }

                chosen_seed_for_session
            }
            Err(e) => {
                eprintln!(
                    "[SyncInit] DB query error for sub_accounts ({}), falling back to provided mnemonic",
                    e
                );
                mnemonic.clone()
            }
        }
    } else {
        println!(
            "[SyncInit] DB pool unavailable; falling back to provided mnemonic for account_id={}",
            account_id
        );
        mnemonic.clone()
    }
}

/// Request payload for updating bucket policy
#[derive(Debug, Deserialize, Serialize)]
pub struct UpdateBucketPolicyRequest {
    pub sync_policy: String,
}

/// Tauri command to update the bucket policy
#[tauri::command]
pub async fn set_bucket_policy(
    app: tauri::AppHandle,
    account_id: String,
    mnemonic: String,
    policy: UpdateBucketPolicyRequest,
) -> Result<(), String> {
    // Validate sync_policy
    let sync_policy = match policy.sync_policy.as_str() {
        "mirror_local_deletes" => Ok("mirror_local_deletes"),
        "restore_from_remote" => Ok("restore_from_remote"),
        "local_only_deletes" => Ok("local_only_deletes"),
        "upload_only" => Ok("upload_only"),
        _ => Err("Invalid sync_policy value. Must be one of: 'mirror_local_deletes', 'restore_from_remote', 'local_only_deletes', 'upload_only'"),
    }.map_err(|e| e.to_string())?;

    let pool = crate::DB_POOL
        .get()
        .ok_or("Database pool not initialized")?;

    sqlx::query(
        r#"
        UPDATE bucket_policies 
        SET sync_policy = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
        "#,
    )
    .bind(sync_policy)
    .execute(pool)
    .await
    .map_err(|e| format!("Failed to update bucket policy: {}", e))?;

    println!(
        "[BucketPolicy] Updated bucket policy - sync_policy: {}",
        policy.sync_policy
    );

    // 2. Stop all running sync processes
    println!("[BucketPolicy] Stopping all sync processes...");
    cleanup_sync(app.clone()).await?;

    // 3. Restart sync processes with the new policy
    println!("[BucketPolicy] Restarting sync processes with new policy...");
    initialize_sync(app, account_id, mnemonic).await?;

    println!("[BucketPolicy] Sync processes restarted with new policy");
    Ok(())
}

#[tauri::command]
pub async fn get_bucket_policy() -> Result<UpdateBucketPolicyRequest, String> {
    let pool = crate::DB_POOL
        .get()
        .ok_or("Database pool not initialized")?;

    let policy: (String,) = sqlx::query_as("SELECT sync_policy FROM bucket_policies WHERE id = 1")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Failed to fetch bucket policy: {}", e))?;

    Ok(UpdateBucketPolicyRequest {
        sync_policy: policy.0,
    })
}

// Helper to convert string to DeletePolicy
fn get_delete_policy_from_str(
    policy_str: &str,
) -> Result<crate::sync_engine::DeletePolicy, String> {
    match policy_str {
        "mirror_local_deletes" => Ok(crate::sync_engine::DeletePolicy::MirrorLocalDeletes),
        "restore_from_remote" => Ok(crate::sync_engine::DeletePolicy::RestoreFromRemote),
        "local_only_deletes" => Ok(crate::sync_engine::DeletePolicy::LocalOnlyDeletes),
        "upload_only" => Ok(crate::sync_engine::DeletePolicy::UploadOnly),
        _ => Err(format!("Invalid delete policy: {}", policy_str)),
    }
}

// Helper to get delete policy from database
pub async fn get_sync_policy_from_db() -> Result<crate::sync_engine::DeletePolicy, String> {
    let pool = crate::DB_POOL
        .get()
        .ok_or("Database pool not initialized")?;

    let policy_str: (String,) =
        sqlx::query_as("SELECT sync_policy FROM bucket_policies WHERE id = 1")
            .fetch_one(pool)
            .await
            .map_err(|e| format!("Failed to fetch sync policy: {}", e))?;

    get_delete_policy_from_str(&policy_str.0)
}
