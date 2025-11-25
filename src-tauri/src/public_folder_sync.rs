pub use crate::sync_shared::{
    BucketItem, GLOBAL_CANCEL_TOKEN, S3_PUBLIC_SYNC_STATE, SYNCING_ACCOUNTS, folder_size,
    insert_bucket_item_if_absent,
};

use crate::utils::s3_client::make_s3_client;
use crate::{
    DB_POOL,
    commands::syncing::{decrypt_phrase, load_encryption_key},
    sync_engine::{DeletePolicy, prunefile_id, sync_once_cas},
    sync_shared::{MAX_RECENT_ITEMS, RecentItem},
    utils::{
        fs_watcher::{FsEvent, FsWatcher},
        sync::get_public_sync_path,
    },
};

use aws_sdk_s3::Client;
use sp_core::{Pair, crypto::Ss58Codec, sr25519};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{Notify, mpsc};

#[derive(Clone, Default)]
struct SyncSignal {
    notify: Arc<Notify>,
    pending: Arc<AtomicBool>,
}

impl SyncSignal {
    fn new() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            pending: Arc::new(AtomicBool::new(false)),
        }
    }
    /// Mark that work is pending and wake the scheduler.
    fn trigger(&self) {
        self.pending.store(true, Ordering::Release);
        self.notify.notify_one();
    }
    /// Drain the pending flag (returns previous value).
    fn take_pending(&self) -> bool {
        self.pending.swap(false, Ordering::AcqRel)
    }
}

/// Small randomized backoff: 25–150ms (used to break CAS lockstep on conflicts)
fn small_jitter_delay() -> Duration {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let nanos = now.subsec_nanos() as u64;
    let jitter_ms = 25 + (nanos % 126); // 25..150
    Duration::from_millis(jitter_ms)
}

/// Ensure bucket exists and is public-read.
async fn ensure_bucket(client: &Client, bucket: &str) {
    match client.head_bucket().bucket(bucket).send().await {
        Ok(_) => {
            println!("Found existing public bucket");
            return;
        }
        Err(_) => {
            let result = client.create_bucket().bucket(bucket).send().await;
            match result {
                Ok(_) => {
                    println!("Successfully created public bucket");
                    if let Err(e) = apply_public_bucket_policy(client, bucket).await {
                        eprintln!("Failed to apply public bucket policy: {}", e);
                    }
                }
                Err(result) => {
                    println!("Failed to create public bucket: {:#?}", result);
                }
            }
        }
    }
}

async fn apply_public_bucket_policy(
    client: &Client,
    bucket_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let bucket_policy = format!(
        r#"{{
            "Version": "2012-10-17",
            "Statement": [
                {{
                    "Effect": "Allow",
                    "Principal": "*",
                    "Action": ["s3:GetObject"],
                    "Resource": ["arn:aws:s3:::{bucket}/*"]
                }}
            ]
        }}"#,
        bucket = bucket_name
    );

    client
        .put_bucket_policy()
        .bucket(bucket_name)
        .policy(bucket_policy)
        .send()
        .await?;

    println!(
        "[PublicFolderSync] Applied public-read bucket policy to '{}'.",
        bucket_name
    );
    Ok(())
}

/// FS watcher -> DB updates + *trigger* single-flight sync.
async fn handle_fs_events(
    mut rx: mpsc::UnboundedReceiver<FsEvent>,
    pool: SqlitePool,
    owner: String,
    bucket_name: String,
    signal: SyncSignal, // <--- NEW
) {
    let mut batch = Vec::new();
    let batch_timeout = tokio::time::sleep(Duration::from_millis(100));
    tokio::pin!(batch_timeout);

    loop {
        tokio::select! {
            Some(event) = rx.recv() => {
                batch.push(event);
                if !batch.is_empty() {
                    process_batch(&batch, &pool, &owner, &bucket_name).await;
                    batch.clear();
                    // coalesce bursts; request a sync
                    signal.trigger(); // <--- NEW
                    batch_timeout.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(100));
                }
            }
            _ = &mut batch_timeout => {
                if !batch.is_empty() {
                    process_batch(&batch, &pool, &owner, &bucket_name).await;
                    batch.clear();
                    // tail trigger after timeout batch
                    signal.trigger(); // <--- NEW
                }
                batch_timeout.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(100));
            }
        }
    }
}

#[tauri::command]
pub async fn start_public_folder_sync_tauri(
    app_handle: AppHandle,
    account_id: String,
    mnemonic: String,
    policy: DeletePolicy,
) {
    println!(
        "[PublicFolderSync] Starting sync for public, policy {:?}",
        policy
    );
    start_public_folder_sync(app_handle, account_id, mnemonic, policy).await;
}

pub async fn start_public_folder_sync(
    app_handle: AppHandle,
    account_id: String,
    _mnemonic: String,
    deletion_policy: DeletePolicy,
) {
    {
        let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
        if syncing_accounts.contains(&(account_id.clone(), "public")) {
            println!(
                "[PublicFolderSync] Account {} is already syncing, skipping.",
                account_id
            );
            return;
        }
        syncing_accounts.insert((account_id.clone(), "public"));
    }

    // Get local sync root
    let sync_path = match get_public_sync_path().await {
        Ok(path) => path,
        Err(e) => {
            eprintln!("[PublicFolderSync] Failed to get public sync path: {}", e);
            tokio::time::sleep(Duration::from_secs(15)).await;
            return;
        }
    };

    // Activate security-scoped bookmark for macOS
    #[cfg(target_os = "macos")]
    let mut needs_bookmark_creation = false;

    #[cfg(target_os = "macos")]
    {
        use crate::utils::bookmark_db::activate_bookmark;
        match activate_bookmark(&sync_path).await {
            Ok(true) => {
                println!("[PublicFolderSync] Successfully activated bookmark for: {}", sync_path);
            }
            Ok(false) | Err(_) => {
                eprintln!(
                    "[PublicFolderSync] No bookmark found. Will attempt to create one after filesystem access."
                );
                needs_bookmark_creation = true;
            }
        }
    }

    // Ensure directory exists and we have access (triggers permission prompt on macOS if needed)
    // We do this EARLY to ensure we capture the permission in a bookmark as soon as possible,
    // before potentially long-running operations like sub-account resolution.
    if let Err(e) = std::fs::create_dir_all(&sync_path) {
        eprintln!("[PublicFolderSync] Failed to create sync directory: {}", e);
        return;
    }

    #[cfg(target_os = "macos")]
    if needs_bookmark_creation {
        use crate::utils::bookmark_db::{activate_bookmark, store_bookmark};
        println!("[PublicFolderSync] Attempting to create bookmark after successful FS access...");
        if let Err(e) = store_bookmark(&sync_path, "public").await {
            eprintln!("[PublicFolderSync] Failed to create bookmark: {}", e);
        } else {
             // Try activating the newly created bookmark to ensure it works
            match activate_bookmark(&sync_path).await {
                Ok(true) => println!("[PublicFolderSync] Successfully created and activated bookmark"),
                _ => eprintln!("[PublicFolderSync] Failed to activate newly created bookmark"),
            }
        }
    }

    // Resolve sub-account SS58 from DB (unchanged logic)
    let sub_account = loop {
        match DB_POOL.get() {
            Some(pool) => {
                match sqlx::query_as::<_, (String,)>(
                    r#"
                    SELECT sub_account_seed_phrase
                    FROM sub_accounts
                    WHERE account_id = ?
                    LIMIT 1
                    "#,
                )
                .bind(&account_id)
                .fetch_optional(pool)
                .await
                {
                    Ok(Some((sub_account_seed_phrase,))) => {
                        let maybe_key = load_encryption_key(pool).await;
                        let phrase = if let Some(key) = &maybe_key {
                            decrypt_phrase(&sub_account_seed_phrase, key)
                                .unwrap_or_else(|| sub_account_seed_phrase.clone())
                        } else {
                            sub_account_seed_phrase
                        };
                        if let Ok((pair, _)) = sr25519::Pair::from_phrase(&phrase, None) {
                            let ss58 = pair.public().to_ss58check();
                            break ss58;
                        } else {
                            eprintln!("[BucketName] Failed to convert seed phrase to SS58 address");
                            tokio::time::sleep(Duration::from_secs(15)).await;
                        }
                    }
                    Ok(None) => {
                        println!(
                            "[BucketName] No sub-account found for account {}, waiting 15 seconds...",
                            account_id
                        );
                        tokio::time::sleep(Duration::from_secs(15)).await;
                    }
                    Err(e) => {
                        eprintln!("[BucketName] Error querying sub-accounts: {}", e);
                        tokio::time::sleep(Duration::from_secs(15)).await;
                    }
                }
            }
            None => {
                eprintln!("[BucketName] Database pool not available, waiting 15 seconds...");
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        }
    };

    // Bucket + path hash
    let (bucket_name, path_hash) = match crate::sync_shared::get_bucket_name(
        &account_id,
        "public",
        std::path::Path::new(&sync_path),
    ) {
        Ok((name, hash)) => (name, hash),
        Err(e) => {
            eprintln!("[PublicFolderSync] Failed to get bucket name: {}", e);
            tokio::time::sleep(Duration::from_secs(15)).await;
            return;
        }
    };

    let prunefile_id = prunefile_id(&sub_account, &path_hash, "public");

    let s3 = make_s3_client().await;
    ensure_bucket(&s3, &bucket_name).await;

    // FS watcher
    let (tx, rx) = mpsc::unbounded_channel();
    let _watcher = match FsWatcher::new(&sync_path, tx) {
        Ok(watcher) => watcher,
        Err(e) => {
            eprintln!("[PublicFolderSync] Failed to create fs watcher: {}", e);
            return;
        }
    };

    let pool = match DB_POOL.get() {
        Some(p) => p.clone(),
        None => {
            eprintln!("[PublicFolderSync] Database pool not available");
            return;
        }
    };

    let signal = SyncSignal::new();

    {
        let pool_clone = pool.clone();
        let owner_clone = account_id.clone();
        let bucket_name_clone = bucket_name.clone();
        let signal_clone = signal.clone();
        tokio::spawn(async move {
            handle_fs_events(rx, pool_clone, owner_clone, bucket_name_clone, signal_clone).await
        });
    }

    // Immediately request an initial sync
    signal.trigger();

    // 3s minimum interval; 30s heartbeat tick when idle (reduced from 5s to prevent excessive syncs)
    const MIN_INTERVAL: Duration = Duration::from_secs(3);
    const HEARTBEAT: Duration = Duration::from_secs(30);

    let mut last_run_end = Instant::now() - HEARTBEAT;
    let mut running = false;

    // Track whether the previous run likely failed due to CAS conflicts.
    let mut last_run_had_cas_conflict = false;

    loop {
        if GLOBAL_CANCEL_TOKEN.load(Ordering::SeqCst) {
            println!(
                "[PublicFolderSync] Global cancellation detected, stopping sync for account {}",
                account_id
            );
            {
                let mut syncing_accounts = SYNCING_ACCOUNTS.lock().unwrap();
                syncing_accounts.remove(&(account_id.clone(), "public"));
            }
            return;
        }

        // Wait for either FS-trigger or heartbeat
        let until_heartbeat = {
            let elapsed = last_run_end.elapsed();
            if elapsed >= HEARTBEAT {
                Duration::from_millis(0)
            } else {
                HEARTBEAT - elapsed
            }
        };

        tokio::select! {
            _ = signal.notify.notified() => { /* explicit trigger */ }
            _ = tokio::time::sleep(until_heartbeat) => { /* periodic tick */ }
        }

        // No concurrent runs locally; coalesce instead.
        if running {
            continue;
        }

        // Respect min-interval unless we have explicit pending work
        let explicit_pending = signal.take_pending();
        if !explicit_pending && last_run_end.elapsed() < MIN_INTERVAL {
            continue;
        }

        // Jitter when: (a) we have explicit pending work (hot), or (b) the previous run had CAS conflicts.
        if explicit_pending || last_run_had_cas_conflict {
            tokio::time::sleep(small_jitter_delay()).await;
        }

        println!(
            "[PublicFolderSync] Starting reconcile (trigger: {}, elapsed: {:?})...",
            if explicit_pending { "FS_EVENT" } else { "HEARTBEAT" },
            last_run_end.elapsed()
        );
        running = true;

        // mark UI “in progress”
        {
            let mut st = S3_PUBLIC_SYNC_STATE.lock().unwrap();
            st.in_progress = true;
            st.total_files = 0;
            st.processed_files = 0;
            st.uploading_items.retain(|_| false);
        }

        let max_retries = 5;

        let result = sync_once_cas(
            &s3,
            &bucket_name,
            &sync_path,
            deletion_policy,
            max_retries,
            &prunefile_id,
        )
        .await;

        match result {
            Ok(()) => {
                last_run_had_cas_conflict = false;

                // done → mark finished + emit
                let status = {
                    let mut st = S3_PUBLIC_SYNC_STATE.lock().unwrap();
                    st.in_progress = false;
                    st.processed_files = st.total_files;
                    crate::constants::folder_sync::SyncStatusResponse {
                        synced_files: st.processed_files,
                        total_files: st.total_files,
                        in_progress: st.in_progress,
                        percent: 100.0,
                    }
                };
                let _ = app_handle.emit("sync-status-update", &status);

                let _payload = serde_json::json!({
                    "scope": "public",
                    "account_id": account_id,
                    "success": true,
                    "total_files": status.total_files,
                    "processed_files": status.synced_files,
                });
            }
            Err(e) => {
                // Heuristic: treat “CAS:” errors as conflict storms; add jitter before the next attempt.
                let es = e.to_string();
                let casy = es.contains("CAS:")
                    || es.contains("conflicted too many times")
                    || es.contains("412");
                last_run_had_cas_conflict = casy;

                eprintln!("[PublicFolderSync] sync_once_cas error: {e:#}");
                // mark not-in-progress so UI settles
                let status = {
                    let mut st = S3_PUBLIC_SYNC_STATE.lock().unwrap();
                    st.in_progress = false;
                    crate::constants::folder_sync::SyncStatusResponse {
                        synced_files: st.processed_files.min(st.total_files),
                        total_files: st.total_files,
                        in_progress: st.in_progress,
                        percent: if st.total_files > 0 {
                            ((st.processed_files as f32 / st.total_files as f32) * 100.0).min(100.0)
                        } else {
                            0.0
                        },
                    }
                };
                let _ = app_handle.emit("sync-status-update", &status);
            }
        }

        last_run_end = Instant::now();
        running = false;

        // Tail-chain: if new work queued during the run, kick immediately (with a tiny jitter to avoid re-colliding).
        if signal.take_pending() {
            tokio::time::sleep(small_jitter_delay()).await;
            signal.notify.notify_one();
        }
    }
}

/// Processes FS event batches (unchanged aside from imports).
async fn process_batch(events: &[FsEvent], pool: &SqlitePool, owner: &str, bucket_name: &str) {
    let mut new_files = 0;
    let mut recent_items = Vec::new();
    let mut bucket_items = Vec::new();
    let mut file_paths = Vec::new();

    for event in events {
        match event {
            FsEvent::Create(path, is_dir) => {
                let file_name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(name) => name.to_string(),
                    None => continue,
                };

                let size = if *is_dir {
                    folder_size(path)
                } else {
                    std::fs::metadata(path).ok().map(|m| m.len()).unwrap_or(0)
                };

                let bucket_item = BucketItem {
                    path: file_name.clone(),
                    size,
                    last_modified: chrono::Utc::now().to_rfc3339(),
                    is_folder: *is_dir,
                    storage_class: "STANDARD".to_string(),
                    ipfs_hash: "".to_string(),
                    bucket_name: bucket_name.to_string(),
                };
                bucket_items.push(bucket_item);

                if !is_dir {
                    new_files += 1;
                    file_paths.push((file_name.clone(), path.clone()));
                }

                if *is_dir {
                    recent_items.push(RecentItem {
                        name: file_name.clone(),
                        scope: "public".to_string(),
                        action: "uploading".to_string(),
                        kind: "folder".to_string(),
                        path: path.to_string_lossy().to_string(),
                        timestamp: chrono::Utc::now().timestamp_millis(),
                    });
                } else {
                    let upload_item = RecentItem {
                        name: file_name.clone(),
                        scope: "public".to_string(),
                        action: "uploading".to_string(),
                        kind: "file".to_string(),
                        path: path.to_string_lossy().to_string(),
                        timestamp: chrono::Utc::now().timestamp_millis(),
                    };
                    let mut state = S3_PUBLIC_SYNC_STATE.lock().unwrap();
                    if !state
                        .uploading_items
                        .iter()
                        .any(|i| i.path == upload_item.path)
                    {
                        state.uploading_items.push(upload_item);
                    }
                }
            }
            FsEvent::Remove(path, is_dir) => {
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    let recent_item = RecentItem {
                        name: file_name.to_string(),
                        scope: "public".to_string(),
                        action: "deleted".to_string(),
                        kind: if *is_dir { "folder" } else { "file" }.to_string(),
                        path: path.to_string_lossy().to_string(),
                        timestamp: chrono::Utc::now().timestamp_millis(),
                    };
                    recent_items.push(recent_item.clone());
                    if !*is_dir {
                        let mut state = S3_PUBLIC_SYNC_STATE.lock().unwrap();
                        state
                            .uploading_items
                            .retain(|item| item.path != recent_item.path);
                        state.uploading_items.push(recent_item);
                    }
                }
                // Only delete from DB if sync policy is MirrorLocalDeletes
                match crate::commands::syncing::get_sync_policy_from_db().await {
                    Ok(policy)
                        if policy == crate::sync_engine::DeletePolicy::MirrorLocalDeletes =>
                    {
                        if let Ok(sync_root) = crate::utils::sync::get_public_sync_path().await {
                            if let Ok(rel) = path.strip_prefix(&sync_root) {
                                if rel.components().count() == 1 {
                                    if let Some(top) =
                                        rel.components().next().and_then(|c| c.as_os_str().to_str())
                                    {
                                        if let Err(e) =
                                            crate::sync_shared::delete_bucket_item_by_name(
                                                pool, owner, "public", top,
                                            )
                                            .await
                                        {
                                            eprintln!(
                                                "[PublicFolderSync] DB delete failed for '{}': {}",
                                                top, e
                                            );
                                        } else {
                                            println!(
                                                "[PublicFolderSync] Deleted '{}' from database due to MirrorLocalDeletes policy",
                                                top
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Ok(_) => {
                        // Policy is not MirrorLocalDeletes, skip database deletion
                        if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                            println!(
                                "[PublicFolderSync] Skipping DB delete for '{}' as policy is not MirrorLocalDeletes",
                                file_name
                            );
                        }
                    }
                    Err(e) => {
                        eprintln!("[PublicFolderSync] Failed to get sync policy: {}", e);
                    }
                }
            }
        }
    }

    if !bucket_items.is_empty() {
        for item in bucket_items {
            if let Err(e) = insert_bucket_item_if_absent(pool, owner, "public", &item).await {
                eprintln!("[PublicFolderSync] Failed to insert item: {}", e);
            }
        }
    }

    for (file_name, path) in file_paths {
        let _ = sqlx::query(
            "INSERT OR REPLACE INTO file_paths (file_name, file_hash, timestamp, path) VALUES (?, ?, ?, ?)",
        )
        .bind(&file_name)
        .bind("")
        .bind(chrono::Utc::now().timestamp())
        .bind(path.to_string_lossy().to_string())
        .execute(pool)
        .await;
    }

    let _should_emit = {
        let mut state = S3_PUBLIC_SYNC_STATE.lock().unwrap();
        let mut changed = false;

        if new_files > 0 {
            state.total_files = state.total_files.saturating_add(new_files);
            changed = true;
        }

        for item in recent_items {
            if !state
                .recent_items
                .iter()
                .any(|i| i.path == item.path && i.action == item.action)
            {
                state.recent_items.push_front(item.clone());
                changed = true;
                while state.recent_items.len() > MAX_RECENT_ITEMS {
                    state.recent_items.pop_back();
                }
            }
        }

        changed
    };
}
