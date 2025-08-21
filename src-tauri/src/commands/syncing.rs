use crate::user_profile_sync::{start_user_profile_sync_tauri};
use crate::private_folder_sync::start_private_folder_sync_tauri;
use crate::public_folder_sync::start_public_folder_sync_tauri;
use crate::sync_shared::{reset_all_sync_state, prepare_for_new_sync, list_bucket_contents, store_bucket_listing_in_db};
use crate::utils::sync::{get_private_sync_path, get_public_sync_path};
use tauri::Manager;
use tokio::sync::Mutex;
use std::sync::Arc;
use std::env;
use base64::Engine as _;
use base64::{encode};
use sqlx;
use sp_core::{sr25519, crypto::Ss58Codec};
use sp_core::Pair;
use sodiumoxide::crypto::secretbox;
use sodiumoxide::crypto::secretbox::{Key as SbKey, Nonce as SbNonce};
use base64 as b64;
use tauri::State;

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
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    
    // Prepare for new sync (reset cancellation token)
    prepare_for_new_sync();

    // Offload heavy subaccount resolution and task spawning to a background task
    let app_for_bg = app.clone();
    let account_for_bg = account_id.clone();
    let mnemonic_for_bg = mnemonic.clone();
    let parent_task = tokio::spawn(async move {
        // Resolve or create subaccount seed (with encryption and chain-side handling)
        let seed_to_use = resolve_or_create_subaccount_seed(account_for_bg.clone(), mnemonic_for_bg.clone()).await;

        // Configure AWS env
        let encoded_seed = encode(&seed_to_use);
        println!("[SyncInit] Using encrypted subaccount seed from DB for seed_to_use={}, encoded_seed={}", seed_to_use, encoded_seed);
        std::env::set_var("AWS_ACCESS_KEY_ID", &encoded_seed);
        std::env::set_var("AWS_SECRET_ACCESS_KEY", &seed_to_use);
        std::env::set_var("AWS_DEFAULT_REGION", "decentralized");

        // Spawn sync tasks
        let app_handle_clone = app_for_bg.clone();
        let app_handle_folder_sync = app_for_bg.clone();
        let app_handle_public_folder_sync = app_for_bg.clone();
        let account_clone = account_for_bg.clone();
        let account_clone2 = account_for_bg.clone();
        let account_clone3 = account_for_bg.clone();
        let mnemonic_clone = mnemonic_for_bg.clone();

        let user_profile_task = tokio::spawn(async move {
            start_user_profile_sync_tauri(app_handle_clone, account_clone).await;
        });

        // Check DB-configured sync paths and only spawn tasks if present
        let private_enabled = match get_private_sync_path().await {
            Ok(p) if !p.trim().is_empty() => true,
            _ => {
                println!("[SyncInit] No private sync path configured; skipping private folder sync task");
                false
            }
        };

        let public_enabled = match get_public_sync_path().await {
            Ok(p) if !p.trim().is_empty() => true,
            _ => {
                println!("[SyncInit] No public sync path configured; skipping public folder sync task");
                false
            }
        };

        let folder_task = if private_enabled {
            Some(tokio::spawn(async move {
                start_private_folder_sync_tauri(app_handle_folder_sync, account_for_bg, mnemonic_for_bg).await;
            }))
        } else { None };

        let public_folder_task = if public_enabled {
            Some(tokio::spawn(async move {
                start_public_folder_sync_tauri(app_handle_public_folder_sync, account_clone2, mnemonic_clone).await;
            }))
        } else { None };

        // Record task handles into global AppState so cleanup can abort them
        let state = app_for_bg.state::<Arc<AppState>>();
        let mut guard = state.sync.lock().await;
        guard.tasks.push(user_profile_task);
        if let Some(handle) = public_folder_task { guard.tasks.push(handle); }
        if let Some(handle) = folder_task { guard.tasks.push(handle); }

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
                        match crate::sync_shared::list_bucket_contents(account_for_cron_pub.clone(), "public".to_string()).await {
                            Ok(items) => {
                                if let Err(e) = crate::sync_shared::store_bucket_listing_in_db(&pool_pub, &account_for_cron_pub, "public", &items).await {
                                    eprintln!("[S3InventoryCron][public] Failed storing listing: {}", e);
                                } else {
                                    println!("[S3InventoryCron][public] Stored {} items for {}", items.len(), account_for_cron_pub);
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
                        match crate::sync_shared::list_bucket_contents(account_for_cron_priv.clone(), "private".to_string()).await {
                            Ok(items) => {
                                if let Err(e) = crate::sync_shared::store_bucket_listing_in_db(&pool_priv, &account_for_cron_priv, "private", &items).await {
                                    eprintln!("[S3InventoryCron][private] Failed storing listing: {}", e);
                                } else {
                                    println!("[S3InventoryCron][private] Stored {} items for {}", items.len(), account_for_cron_priv);
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
    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    
    println!("Sync cleanup completed");
    Ok(())
}

// Helper: load first encryption key from DB
async fn load_encryption_key(pool: &sqlx::SqlitePool) -> Option<SbKey> {
    match sqlx::query_as::<_, (Vec<u8>,)>("SELECT key FROM encryption_keys ORDER BY id ASC LIMIT 1")
        .fetch_optional(pool)
        .await
    {
        Ok(Some((bytes,))) => {
            if bytes.len() == secretbox::KEYBYTES {
                Some(SbKey::from_slice(&bytes).unwrap())
            } else { None }
        }
        _ => None,
    }
}

// Helper: encrypt plain text with nonce, return base64 of (nonce || ciphertext)
fn encrypt_phrase(plain: &str, key: &SbKey) -> String {
    let nonce = secretbox::gen_nonce();
    let ct = secretbox::seal(plain.as_bytes(), &nonce, key);
    let mut buf = Vec::with_capacity(secretbox::NONCEBYTES + ct.len());
    buf.extend_from_slice(nonce.as_ref());
    buf.extend_from_slice(&ct);
    b64::encode(&buf)
}

// Helper: try decrypt base64 (nonce||ct), else None
fn decrypt_phrase(b64_in: &str, key: &SbKey) -> Option<String> {
    let bytes = b64::decode(b64_in).ok()?;
    if bytes.len() < secretbox::NONCEBYTES { return None; }
    let (nonce_b, ct) = bytes.split_at(secretbox::NONCEBYTES);
    let nonce = SbNonce::from_slice(nonce_b)?;
    let pt = secretbox::open(ct, &nonce, key).ok()?;
    String::from_utf8(pt).ok()
}

// Helper: heavy logic to resolve or create subaccount seed (non-blocking to UI)
async fn resolve_or_create_subaccount_seed(account_id: String, mnemonic: String) -> String {
    // Ensure sodiumoxide is initialized
    let _ = sodiumoxide::init();

    if let Some(pool) = crate::DB_POOL.get() {
        // Load key (required for encrypt/decrypt)
        let maybe_key = load_encryption_key(pool).await;

        match sqlx::query_as::<_, (String,)>(
            "SELECT sub_account_seed_phrase FROM sub_accounts WHERE account_id = ? LIMIT 1"
        )
        .bind(&account_id)
        .fetch_optional(pool)
        .await {
            Ok(Some((stored_str,))) => {
                if let Some(key) = &maybe_key {
                    // Try decrypt; if fails, treat as legacy plaintext and migrate
                    if let Some(decrypted) = decrypt_phrase(&stored_str, key) {
                        println!("[SyncInit] Using encrypted subaccount seed from DB for account_id={}, stored_str={}", account_id, stored_str);
                        return decrypted;
                    } else {
                        println!("[SyncInit] Found legacy plaintext subaccount; re-encrypting for account_id={}", account_id);
                        let enc = encrypt_phrase(&stored_str, key);
                        if let Err(e) = sqlx::query(
                            "UPDATE sub_accounts SET sub_account_seed_phrase = ? WHERE account_id = ?"
                        )
                        .bind(&enc)
                        .bind(&account_id)
                        .execute(pool)
                        .await {
                            eprintln!("[SyncInit] Failed to migrate plaintext subaccount to encrypted: {}", e);
                        }
                        return stored_str;
                    }
                } else {
                    println!("[SyncInit] Encryption key unavailable; using stored subaccount as-is (account_id={})", account_id);
                    return stored_str;
                }
            },
            Ok(None) => {
                // Create a new subaccount (sr25519) and store it encrypted
                let (_pair, phrase, _seed) = sr25519::Pair::generate_with_phrase(None);
                let public = sr25519::Pair::from_phrase(&phrase, None).map(|(p, _)| p.public()).ok();
                if let Some(pubkey) = public {
                    let ss58 = pubkey.to_ss58check();
                    println!("[SyncInit] Created new subaccount for account_id={} ss58={}", account_id, ss58);
                } else {
                    println!("[SyncInit] Created new subaccount for account_id={} (public key derivation failed)", account_id);
                }

                // Ensure only one record per main account: delete existing then insert
                if let Err(e) = sqlx::query("DELETE FROM sub_accounts WHERE account_id = ?")
                    .bind(&account_id)
                    .execute(pool)
                    .await {
                    eprintln!("[SyncInit] Failed to clear existing sub_account for {}: {}", account_id, e);
                }

                let to_store = if let Some(key) = &maybe_key {
                    let enc = encrypt_phrase(&phrase, key);
                    println!("[SyncInit] Storing new subaccount seed encrypted for account_id={}", account_id);
                    enc
                } else {
                    println!("[SyncInit] Encryption key unavailable; storing new subaccount seed in plaintext (account_id={})", account_id);
                    phrase.clone()
                };

                if let Err(e) = sqlx::query(
                    "INSERT INTO sub_accounts (account_id, sub_account_seed_phrase) VALUES (?, ?)"
                )
                .bind(&account_id)
                .bind(&to_store)
                .execute(pool)
                .await {
                    eprintln!("[SyncInit] Failed to insert new subaccount for {}: {}", account_id, e);
                } else {
                    println!("[SyncInit] Stored new subaccount seed phrase for account_id={}", account_id);
                }

                // Try to register subaccount on-chain; if we get the specific
                // "MainCannotBeSubAccount" error, we will fallback to using the
                // provided mnemonic as the subaccount as well (persisting to DB)
                let mut chosen_seed_for_session = phrase.clone();
                {
                    let main_seed_plain = mnemonic.clone();
                    let sub_seed_plain = phrase.clone();
                    match crate::commands::substrate_tx::add_sub_account_tauri(main_seed_plain, sub_seed_plain).await {
                        Ok(msg) => println!("[SyncInit] add_sub_account submitted successfully: {}", msg),
                        Err(err) => {
                            let err_str = err.to_string();
                            eprintln!("[SyncInit] Failed to submit add_sub_account extrinsic: {}", err_str);
                            if err_str.contains("MainCannotBeSubAccount") {
                                println!("[SyncInit] Detected MainCannotBeSubAccount; storing provided mnemonic as subaccount for account_id={}", account_id);
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

                return chosen_seed_for_session;
            },
            Err(e) => {
                eprintln!("[SyncInit] DB query error for sub_accounts ({}), falling back to provided mnemonic", e);
                return mnemonic.clone();
            }
        }
    } else {
        println!("[SyncInit] DB pool unavailable; falling back to provided mnemonic for account_id={}", account_id);
        return mnemonic.clone();
    }
}


#[tauri::command]
pub async fn start_s3_inventory_cron(
    _app_handle: tauri::AppHandle,
    account_id: String,
    interval_secs: Option<u64>,
) -> Result<(), String> {
    let interval = interval_secs.unwrap_or(60); // default 1 minute

    // Clone DB pool for use inside spawned task
    let pool = match crate::DB_POOL.get() {
        Some(p) => p.clone(),
        None => return Err("DB pool unavailable; cannot start S3 inventory cron".to_string()),
    };

    let account = account_id.clone();

    // Spawn a background task
    tauri::async_runtime::spawn(async move {
        loop {
            // Public
            match list_bucket_contents(account.clone(), "public".to_string()).await {
                Ok(items) => {
                    if let Err(e) = store_bucket_listing_in_db(&pool, &account, "public", &items).await {
                        eprintln!("[S3InventoryCron] Failed storing public listing: {}", e);
                    } else {
                        println!("[S3InventoryCron] Stored {} public items for {}", items.len(), account);
                    }
                }
                Err(e) => eprintln!("[S3InventoryCron] Public list failed: {}", e),
            }

            // Private
            match list_bucket_contents(account.clone(), "private".to_string()).await {
                Ok(items) => {
                    if let Err(e) = store_bucket_listing_in_db(&pool, &account, "private", &items).await {
                        eprintln!("[S3InventoryCron] Failed storing private listing: {}", e);
                    } else {
                        println!("[S3InventoryCron] Stored {} private items for {}", items.len(), account);
                    }
                }
                Err(e) => eprintln!("[S3InventoryCron] Private list failed: {}", e),
            }

            tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
        }
    });

    Ok(())
}
