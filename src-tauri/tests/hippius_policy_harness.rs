// tests/hippius_policy_harness.rs
//
// Shared mini-harness for the policy tests. Mirrors your original compose
// bootstrap (Windows-safe), and exposes compact helpers for the tests.
// UPDATED: adds a few helpers (wait_remote_contains_all, read_remote_text,
//          read_local_text, dual_rename_propagates, dual_rename_upload_only).
// UPDATED: adds panic-safe teardown via RAII (BootCtx::Drop) + early guard in boot_stack().
// UPDATED (2025-11): adds remote_mutation helpers (remote_delete_many, remote_put_text,
//          remote_put_many_with_body, wait_remote_absent_all, remote_rename), a seeding helper for
//          UploadOnly without rename conflict, and explicit rename/rename conflict helpers.
//
// SAFETY PATCH (fresh-clone friendly):
// - Never operates on tests/fixtures/hippius-s3 unless you explicitly set HIPPIUS_S3_DIR.
// - By default clones thenervelab/hippius-s3 into target/itest/hippius-s3.
// - No 'git remote set-url' anywhere; only operates inside the throwaway clone.
//
// PRUNED (2025-11): removed unused helpers: read_local_variants, conflict_prefix_for (and
// join_rel/split_dir_and_stem), list_local_keys_with_prefix, assert_dual_rename_upload_only,
// assert_rename_rename_conflict_upload_only.

use anyhow::{Context, Result, anyhow};
use aws_config::BehaviorVersion;
use aws_credential_types::{Credentials, provider::SharedCredentialsProvider};
use aws_sdk_s3 as s3;
use aws_sdk_s3::primitives::ByteStream;
use aws_types::region::Region;
use base64::{Engine as _, engine::general_purpose};
use std::{
    collections::HashSet,
    fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tempfile::TempDir;
use tokio::{fs as tokio_fs, io::AsyncWriteExt, time};
use uuid::Uuid;

// Real sync engine
pub use tauri_project_lib::sync_engine::{DeletePolicy, sync_once_cas};

/* ----------------- Always-tear-down safety (panic-safe) ----------------- */

fn keep_stacks() -> bool {
    matches!(
        std::env::var("SMOKE_KEEP_STACK").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

/// Best-effort, non-panicking `docker compose down --volumes`.
/// Swallows all errors — safe to call from Drop and during unwinding.
fn down_stack_best_effort(repo_dir: &Path, files: &[PathBuf], project: &str) {
    // Try docker compose v2 first, then classic docker-compose.
    let attempts: [(&str, &[&str]); 2] = [("docker", &["compose"]), ("docker-compose", &[])];
    for (prog, prefix) in attempts {
        let mut cmd = Command::new(prog);
        cmd.current_dir(repo_dir);
        #[cfg(windows)]
        {
            cmd.env("COMPOSE_CONVERT_WINDOWS_PATHS", "1");
        }
        for (k, v) in compose_env_defaults() {
            cmd.env(k, v);
        }
        for p in prefix {
            cmd.arg(p);
        }
        for f in files {
            cmd.arg("-f").arg(f);
        }
        cmd.arg("--project-name").arg(project);
        cmd.arg("down").arg("--volumes");
        let _ = cmd.status(); // ignore failures
    }
}

/// Guard used inside `boot_stack()` to clean up on early failure (before BootCtx exists).
struct ComposeTeardownGuard {
    repo: PathBuf,
    compose_files: Vec<PathBuf>,
    project: String,
}
impl ComposeTeardownGuard {
    fn new(repo: &Path, files: &[PathBuf], project: &str) -> Self {
        Self {
            repo: repo.to_path_buf(),
            compose_files: files.to_vec(),
            project: project.to_string(),
        }
    }
    /// Disable the guard after a successful boot (BootCtx's Drop will take over).
    fn disarm(self) {
        std::mem::forget(self);
    }
}
impl Drop for ComposeTeardownGuard {
    fn drop(&mut self) {
        if keep_stacks() {
            eprintln!(
                "[compose] SMOKE_KEEP_STACK=1 — keeping stack (project:{})",
                self.project
            );
            return;
        }
        down_stack_best_effort(&self.repo, &self.compose_files, &self.project);
    }
}

pub const SEED_PHRASE: &str =
    "sudden lemon blade cereal desert swallow wing bacon fluid surprise couch"; // test-only

/* ----------------- Client context ----------------- */

pub struct ClientCtx {
    pub name: String,
    pub s3: s3::Client,
    pub bucket: String,
    pub local_root: PathBuf,
    pub prunefile_id: String,
    pub delete_policy: DeletePolicy,
    pub max_retries: usize,
}

pub async fn make_client_ctx(
    name: &str,
    endpoint: &str,
    bucket: &str,
    prunefile_id: String,
    policy: DeletePolicy,
) -> Result<(ClientCtx, TempDir)> {
    let tmp = TempDir::new()?;
    let ctx = ClientCtx {
        name: name.to_string(),
        s3: s3_client(endpoint).await?,
        bucket: bucket.to_string(),
        local_root: tmp.path().to_path_buf(),
        prunefile_id,
        delete_policy: policy,
        max_retries: 5,
    };
    Ok((ctx, tmp))
}

/* ----------------- Public helpers used by tests ----------------- */

pub fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(default)
}

pub async fn write_one(root: &Path, key: &str, body: &str) -> Result<()> {
    let full = to_local_path(root, key);
    if let Some(parent) = full.parent() {
        tokio_fs::create_dir_all(parent).await?;
    }
    let mut f = tokio_fs::File::create(&full).await?;
    f.write_all(body.as_bytes()).await?;
    Ok(())
}

pub async fn write_many(root: &Path, keys: &[String], who: &str) -> Result<()> {
    for k in keys {
        let payload = format!(
            "create {who} key:{k} ts:{:?}\n",
            std::time::SystemTime::now()
        );
        write_one(root, k, &payload).await?;
    }
    Ok(())
}

pub async fn write_many_with_body(root: &Path, keys: &[String], body_prefix: &str) -> Result<()> {
    for k in keys {
        let payload = format!(
            "{body_prefix} key:{k} ts:{:?}\n",
            std::time::SystemTime::now()
        );
        write_one(root, k, &payload).await?;
    }
    Ok(())
}

pub async fn delete_many(root: &Path, keys: &[String]) -> Result<()> {
    for k in keys {
        let full = to_local_path(root, k);
        let _ = tokio_fs::remove_file(&full).await;
    }
    Ok(())
}

pub fn list_local_pair_keys(root: &Path) -> Result<HashSet<String>> {
    let mut out = HashSet::new();
    fn walk(base: &Path, cur: &Path, out: &mut HashSet<String>) -> Result<()> {
        for entry in fs::read_dir(cur)? {
            let e = entry?;
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out)?;
            } else if p.is_file() {
                let rel = p.strip_prefix(base).unwrap().to_path_buf();
                let k = rel.to_string_lossy().replace('\\', "/");
                if k.starts_with("pair/") {
                    out.insert(k);
                }
            }
        }
        Ok(())
    }
    walk(root, root, &mut out)?;
    Ok(out)
}

pub fn read_local_text(root: &Path, key: &str) -> Result<String> {
    let p = to_local_path(root, key);
    let s = fs::read_to_string(&p).with_context(|| format!("read local file {}", key))?;
    Ok(s)
}

pub async fn list_remote_pair_keys(s3c: &s3::Client, bucket: &str) -> Result<HashSet<String>> {
    let mut out = HashSet::new();
    let mut token: Option<String> = None;
    loop {
        let mut req = s3c
            .list_objects_v2()
            .bucket(bucket)
            .max_keys(1000)
            .prefix("pair/");
        if let Some(t) = &token {
            req = req.continuation_token(t);
        }
        let resp = req.send().await?;
        if let Some(contents) = resp.contents {
            for obj in contents {
                if let Some(key) = obj.key {
                    out.insert(key);
                }
            }
        }
        if resp.is_truncated.unwrap_or(false) {
            token = resp.next_continuation_token;
        } else {
            break;
        }
    }
    Ok(out)
}

/// Read a remote object's body into a UTF-8 string (lossy).
pub async fn read_remote_text(s3c: &s3::Client, bucket: &str, key: &str) -> Result<String> {
    use tokio::io::AsyncReadExt;
    let obj = s3c.get_object().bucket(bucket).key(key).send().await?;
    let mut reader = obj.body.into_async_read();
    let mut buf = Vec::new();
    reader.read_to_end(&mut buf).await?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/* ----------------- New: Remote mutation helpers ----------------- */

/// Delete a batch of keys directly on the remote (simulating a third client or server-side change).
pub async fn remote_delete_many(s3c: &s3::Client, bucket: &str, keys: &[String]) -> Result<()> {
    for k in keys {
        let _ = s3c.delete_object().bucket(bucket).key(k).send().await;
    }
    Ok(())
}

/// Put (create/overwrite) a single key on the remote with the given body.
pub async fn remote_put_text(s3c: &s3::Client, bucket: &str, key: &str, body: &str) -> Result<()> {
    s3c.put_object()
        .bucket(bucket)
        .key(key)
        .body(ByteStream::from(body.as_bytes().to_vec()))
        .content_length(body.len() as i64)
        .send()
        .await?;
    Ok(())
}

/// Put (create/overwrite) many remote keys with a shared body prefix.
pub async fn remote_put_many_with_body(
    s3c: &s3::Client,
    bucket: &str,
    keys: &[String],
    body_prefix: &str,
) -> Result<()> {
    for k in keys {
        let body = format!(
            "{body_prefix} key:{k} ts:{:?}\n",
            std::time::SystemTime::now()
        );
        remote_put_text(s3c, bucket, k, &body).await?;
    }
    Ok(())
}

/// Server-initiated *de facto* rename (copy body to new key, then delete old key).
pub async fn remote_rename(
    s3c: &s3::Client,
    bucket: &str,
    old_key: &str,
    new_key: &str,
) -> Result<()> {
    let body = read_remote_text(s3c, bucket, old_key).await?;
    remote_put_text(s3c, bucket, new_key, &body).await?;
    let _ = s3c.delete_object().bucket(bucket).key(old_key).send().await;
    Ok(())
}

/// Wait until none of `needed` keys are present on the remote, nudging both clients.
pub async fn wait_remote_absent_all(
    s3c: &s3::Client,
    bucket: &str,
    needed: &std::collections::HashSet<String>,
    a: &ClientCtx,
    b: &ClientCtx,
    iters: usize,
) -> Result<()> {
    for i in 0..iters {
        let r = list_remote_pair_keys(s3c, bucket).await?;
        if needed.iter().all(|k| !r.contains(k)) {
            return Ok(());
        }
        // nudge & tick
        sync_both(a, b, 1).await?;
        time::sleep(Duration::from_millis(120)).await;
        if i + 1 == iters {
            let still: Vec<_> = needed.iter().filter(|k| r.contains(*k)).cloned().collect();
            return Err(anyhow!(
                "remote still has keys after {iters} iters: {:?}",
                still
            ));
        }
    }
    Ok(())
}

/* ----------------- Sync rounds ----------------- */

pub async fn one_sync_round(c: &ClientCtx) -> Result<()> {
    let mut delay_ms = 150u64;
    let max_attempts = 5usize;
    for attempt in 1..=max_attempts {
        let res = sync_once_cas(
            &c.s3,
            &c.bucket,
            c.local_root.to_str().unwrap(),
            c.delete_policy,
            c.max_retries,
            &c.prunefile_id,
        )
        .await;

        match res {
            Ok(_) => return Ok(()),
            Err(e) if looks_like_ban(&e) => {
                eprintln!(
                    "[{}] sync_once_cas ban-like err (attempt {attempt}/{max_attempts}); sleep {}ms",
                    c.name, delay_ms
                );
                time::sleep(Duration::from_millis(delay_ms)).await;
                delay_ms = (delay_ms.saturating_mul(2)).min(1500);
            }
            Err(e) => return Err(e).with_context(|| format!("sync_once_cas({}) failed", c.name)),
        }
    }
    Err(anyhow!(
        "sync_once_cas({}) failed persistently with ban-like errors",
        c.name
    ))
}

pub async fn sync_both(a: &ClientCtx, b: &ClientCtx, rounds: usize) -> Result<()> {
    for _ in 0..rounds {
        let (ra, rb) = tokio::join!(one_sync_round(a), one_sync_round(b));
        ra?;
        rb?;
    }
    Ok(())
}

pub async fn sync_until_present_on_both(
    a: &ClientCtx,
    b: &ClientCtx,
    keys: &[String],
    max_iters: usize,
) -> Result<()> {
    let mut it = 0usize;
    let target: HashSet<_> = keys.iter().cloned().collect();
    loop {
        sync_both(a, b, 1).await?;
        let a_local = list_local_pair_keys(&a.local_root)?;
        let b_local = list_local_pair_keys(&b.local_root)?;
        let ok = target
            .iter()
            .all(|k| a_local.contains(k) && b_local.contains(k));
        if ok {
            return Ok(());
        }
        it += 1;
        if it >= max_iters {
            let missing_a: Vec<_> = target
                .iter()
                .filter(|k| !a_local.contains(*k))
                .cloned()
                .collect();
            let missing_b: Vec<_> = target
                .iter()
                .filter(|k| !b_local.contains(*k))
                .cloned()
                .collect();
            return Err(anyhow!(
                "Expected keys not present after {max_iters} syncs; A missing: {:?} B missing: {:?}",
                missing_a,
                missing_b
            ));
        }
        time::sleep(Duration::from_millis(120)).await;
    }
}

pub async fn sync_until_absent_on_both(
    a: &ClientCtx,
    b: &ClientCtx,
    a_del: &[String],
    b_del: &[String],
    max_iters: usize,
) -> Result<()> {
    let mut it = 0usize;
    let target: HashSet<_> = a_del.iter().chain(b_del.iter()).cloned().collect();
    loop {
        sync_both(a, b, 1).await?;
        let a_local = list_local_pair_keys(&a.local_root)?;
        let b_local = list_local_pair_keys(&b.local_root)?;
        let ok = target
            .iter()
            .all(|k| !a_local.contains(k) && !b_local.contains(k));
        if ok {
            return Ok(());
        }
        it += 1;
        if it >= max_iters {
            let still_a: Vec<_> = target
                .iter()
                .filter(|k| a_local.contains(*k))
                .cloned()
                .collect();
            let still_b: Vec<_> = target
                .iter()
                .filter(|k| b_local.contains(*k))
                .cloned()
                .collect();
            return Err(anyhow!(
                "Deleted keys still present after {max_iters} syncs; A:{:?} B:{:?}",
                still_a,
                still_b
            ));
        }
        time::sleep(Duration::from_millis(120)).await;
    }
}

/// Wait until all 'needed' keys are present on the remote, nudging both clients.
pub async fn wait_remote_contains_all(
    s3c: &s3::Client,
    bucket: &str,
    needed: &std::collections::HashSet<String>,
    a: &ClientCtx,
    b: &ClientCtx,
    iters: usize,
) -> Result<()> {
    for i in 0..iters {
        let r = list_remote_pair_keys(s3c, bucket).await?;
        if needed.iter().all(|k| r.contains(k)) {
            return Ok(());
        }
        // nudge & tick
        sync_both(a, b, 1).await?;
        time::sleep(Duration::from_millis(120)).await;
        if i + 1 == iters {
            let missing: Vec<_> = needed.iter().filter(|k| !r.contains(*k)).cloned().collect();
            return Err(anyhow!(
                "remote missing keys after {iters} iters: {:?}",
                missing
            ));
        }
    }
    Ok(())
}

/* ----------------- Rename propagation assertions ----------------- */

/// Create → rename locally on A → assert:
///   - remote has ONLY the new name,
///   - both clients carry ONLY the new name,
///   - the old name never reappears across several sync rounds.
pub async fn assert_rename_propagates(
    a: &ClientCtx,
    b: &ClientCtx,
    bucket: &str,
    old_key: &str,
    new_key: &str,
    rounds_after_rename: usize,
    check_iters: usize,
) -> Result<()> {
    // Create on A and ensure both adopt
    write_one(&a.local_root, old_key, "seed\n").await?;
    sync_until_present_on_both(a, b, &[old_key.to_string()], check_iters).await?;

    // Rename locally on A
    rename_one(&a.local_root, old_key, new_key).await?;

    // Let sync converge
    for _ in 0..rounds_after_rename {
        sync_both(a, b, 1).await?;
    }

    // Remote: ONLY new key
    let remote_now = list_remote_pair_keys(&a.s3, bucket).await?;
    assert!(
        remote_now.contains(new_key),
        "remote must contain renamed key {}",
        new_key
    );
    assert!(
        !remote_now.contains(old_key),
        "remote must NOT retain old key {} after rename",
        old_key
    );

    // Both clients: ONLY new key
    for ctx in [a, b] {
        let local = list_local_pair_keys(&ctx.local_root)?;
        assert!(
            local.contains(new_key),
            "client {} must have new key {}",
            ctx.name,
            new_key
        );
        assert!(
            !local.contains(old_key),
            "client {} must NOT keep old key {} after rename",
            ctx.name,
            old_key
        );
    }

    // Stability: old must not reappear
    for _ in 0..3 {
        sync_both(a, b, 1).await?;
        let ra = list_local_pair_keys(&a.local_root)?;
        let rb = list_local_pair_keys(&b.local_root)?;
        let rr = list_remote_pair_keys(&a.s3, bucket).await?;
        assert!(
            !ra.contains(old_key),
            "A: old key {} must not reappear",
            old_key
        );
        assert!(
            !rb.contains(old_key),
            "B: old key {} must not reappear",
            old_key
        );
        assert!(
            !rr.contains(old_key),
            "remote: old key {} must not reappear",
            old_key
        );
    }

    Ok(())
}

/// Two independent renames performed concurrently (policies with propagation).
/// Asserts ONLY new keys exist remotely and both clients keep the new names.
pub async fn assert_dual_rename_propagates(
    a: &ClientCtx,
    b: &ClientCtx,
    bucket: &str,
    old_a: &str,
    new_a: &str,
    old_b: &str,
    new_b: &str,
    rounds_after_rename: usize,
    check_iters: usize,
) -> Result<()> {
    // Seed both 'old' keys and ensure both clients have them
    write_one(&a.local_root, old_a, "seed\n").await?;
    write_one(&b.local_root, old_b, "seed\n").await?;
    let both = vec![old_a.to_string(), old_b.to_string()];
    sync_until_present_on_both(a, b, &both, check_iters).await?;

    // Rename concurrently: A: old_a->new_a, B: old_b->new_b
    let (ra, rb) = tokio::join!(
        rename_one(&a.local_root, old_a, new_a),
        rename_one(&b.local_root, old_b, new_b)
    );
    ra?;
    rb?;

    for _ in 0..rounds_after_rename {
        sync_both(a, b, 1).await?;
    }

    let remote = list_remote_pair_keys(&a.s3, bucket).await?;
    // Only new keys on remote
    for (old, new) in [(old_a, new_a), (old_b, new_b)] {
        assert!(
            remote.contains(new),
            "remote must contain renamed key {new}"
        );
        assert!(
            !remote.contains(old),
            "remote must NOT retain old key {old}"
        );
    }

    // Both clients only have new names
    for ctx in [a, b] {
        let local = list_local_pair_keys(&ctx.local_root)?;
        assert!(
            local.contains(new_a) && local.contains(new_b),
            "client {} must have both renamed keys",
            ctx.name
        );
        assert!(
            !local.contains(old_a) && !local.contains(old_b),
            "client {} must not retain the old names",
            ctx.name
        );
    }

    // Stability
    for _ in 0..3 {
        sync_both(a, b, 1).await?;
        let rr = list_remote_pair_keys(&a.s3, bucket).await?;
        assert!(
            rr.contains(new_a) && rr.contains(new_b),
            "remote keeps new keys"
        );
        assert!(
            !rr.contains(old_a) && !rr.contains(old_b),
            "remote old names must not reappear"
        );
    }
    Ok(())
}

/* ----------------- New: UploadOnly seeding & rename/rename conflict helpers -------------- */

/// For UploadOnly: seed a shared file present on both clients **without** causing a conflict rename.
/// Strategy: write identical content on both; sync A once to upload; then sync B once to adopt.
pub async fn seed_shared_file_no_conflict_upload_only(
    a: &ClientCtx,
    b: &ClientCtx,
    key: &str,
    body: &str,
    check_iters: usize,
) -> Result<()> {
    write_one(&a.local_root, key, body).await?;
    write_one(&b.local_root, key, body).await?;

    // Sync A first to establish the remote object, then B to reconcile.
    one_sync_round(a).await?;
    one_sync_round(b).await?;

    // Small settle.
    sync_both(a, b, 1).await?;

    // Expect both locals still have the same key (no conflict rename).
    for ctx in [a, b] {
        let local = list_local_pair_keys(&ctx.local_root)?;
        assert!(local.contains(key), "{} must keep seeded {}", ctx.name, key);
    }
    // Remote must contain the key
    let needed: std::collections::HashSet<String> = [key.to_string()].into_iter().collect();
    wait_remote_contains_all(&a.s3, &a.bucket, &needed, a, b, check_iters).await?;

    // Bodies should be the same initially
    for ctx in [a, b] {
        let body_now = read_local_text(&ctx.local_root, key)?;
        assert!(
            body_now.contains("seed-shared"),
            "seeded file body must contain seed-shared tag"
        );
    }
    Ok(())
}

/// Rename/Rename **same file** conflict assertion for propagation policies
/// (MirrorLocalDeletes / LocalOnlyDeletes / RestoreFromRemote):
/// - seed 'old' on A and ensure both clients adopt,
/// - concurrently rename A->new_a and B->new_b,
/// - assert remote has ONLY new_a & new_b (no old),
/// - assert both clients have both new keys and not the old.
pub async fn assert_rename_rename_conflict_propagates(
    a: &ClientCtx,
    b: &ClientCtx,
    bucket: &str,
    old_key: &str,
    new_a: &str,
    new_b: &str,
    rounds_after_rename: usize,
    check_iters: usize,
) -> Result<()> {
    // Seed on A and ensure both have it
    write_one(&a.local_root, old_key, "seed\n").await?;
    sync_until_present_on_both(a, b, &[old_key.to_string()], check_iters).await?;

    // Concurrently rename on both to different targets
    let (ra, rb) = tokio::join!(
        rename_one(&a.local_root, old_key, new_a),
        rename_one(&b.local_root, old_key, new_b),
    );
    ra?;
    rb?;

    for _ in 0..rounds_after_rename {
        sync_both(a, b, 1).await?;
    }

    // Remote: only new keys
    let remote = list_remote_pair_keys(&a.s3, bucket).await?;
    assert!(
        remote.contains(new_a) && remote.contains(new_b),
        "remote must contain both new names"
    );
    assert!(
        !remote.contains(old_key),
        "remote must not contain old name after conflicting renames"
    );

    // Both clients have both new keys and not the old
    for ctx in [a, b] {
        let local = list_local_pair_keys(&ctx.local_root)?;
        assert!(
            local.contains(new_a) && local.contains(new_b),
            "{} must contain both new names",
            ctx.name
        );
        assert!(
            !local.contains(old_key),
            "{} must not contain the old name",
            ctx.name
        );
    }

    Ok(())
}

/* ----------------- Name-agnostic variant discovery by content -------------- */

/// A short, searchable tag embedded in object bodies to group related variants.
pub fn gid_tag(gid: &str) -> String {
    format!("gid:{gid}")
}

/// Write one file whose body carries markers `gid:` and `who:`.
pub async fn write_marked(root: &Path, key: &str, gid: &str, who: &str, label: &str) -> Result<()> {
    let body = format!(
        "{label} who:{who} gid:{gid} ts:{:?}\n",
        std::time::SystemTime::now()
    );
    write_one(root, key, &body).await
}

/// Return all *local* (key, body) pairs whose body contains `gid`.
pub fn find_local_by_gid(root: &Path, gid: &str) -> Result<Vec<(String, String)>> {
    let marker = gid_tag(gid);
    let keys = list_local_pair_keys(root)?;
    let mut out = Vec::new();
    for k in keys {
        let body = read_local_text(root, &k)?;
        if body.contains(&marker) {
            out.push((k, body));
        }
    }
    Ok(out)
}

/// Return all *remote* (key, body) pairs whose body contains `gid`.
pub async fn find_remote_by_gid(
    s3c: &s3::Client,
    bucket: &str,
    gid: &str,
) -> Result<Vec<(String, String)>> {
    let marker = gid_tag(gid);
    let keys = list_remote_pair_keys(s3c, bucket).await?;
    let mut out = Vec::new();
    for k in keys {
        if let Ok(body) = read_remote_text(s3c, bucket, &k).await {
            if body.contains(&marker) {
                out.push((k, body));
            }
        }
    }
    Ok(out)
}

/// Count distinct bodies among (key, body) pairs.
pub fn distinct_body_count(items: &[(String, String)]) -> usize {
    let mut hs = HashSet::new();
    for (_, b) in items {
        hs.insert(b.clone());
    }
    hs.len()
}

/// Convenience: does any body carry `who:<id>`?
pub fn contains_body_from(items: &[(String, String)], who: &str) -> bool {
    let needle = format!("who:{who}");
    items.iter().any(|(_, b)| b.contains(&needle))
}

/* ----------------- Local FS smalls ----------------- */

pub fn to_local_path(root: &Path, key: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for seg in key.split('/') {
        p.push(seg);
    }
    p
}

pub async fn rename_one(root: &Path, from_key: &str, to_key: &str) -> Result<()> {
    let src = to_local_path(root, from_key);
    let dst = to_local_path(root, to_key);
    if let Some(parent) = dst.parent() {
        tokio_fs::create_dir_all(parent).await?;
    }
    tokio_fs::rename(&src, &dst)
        .await
        .with_context(|| format!("rename {} -> {}", from_key, to_key))?;
    Ok(())
}

fn looks_like_ban(err: &anyhow::Error) -> bool {
    let s = err.to_string();
    s.contains("temporarily banned") || s.contains("AccessDenied") || s.contains("403")
}

/* ----------------- S3 client ----------------- */

pub async fn s3_client(endpoint: &str) -> Result<s3::Client> {
    let access_key = general_purpose::STANDARD.encode(SEED_PHRASE);
    let creds = Credentials::new(access_key, SEED_PHRASE, None, None, "static");

    let base = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new("us-east-1"))
        .credentials_provider(SharedCredentialsProvider::new(creds))
        .load()
        .await;

    let conf = s3::config::Builder::from(&base)
        .endpoint_url(endpoint)
        .force_path_style(true)
        .build();
    Ok(s3::Client::from_conf(conf))
}

/* ----------------- hippius-s3 repo + docker plumbing (compact) ------------- */

pub struct BootCtx {
    pub repo: PathBuf,
    pub compose_files: Vec<PathBuf>,
    pub project: String,
    pub gateway_port: u16,
    pub s3_endpoint: String,
}

// Panic-safe teardown when BootCtx goes out of scope (even if a test panics).
impl Drop for BootCtx {
    fn drop(&mut self) {
        if keep_stacks() {
            eprintln!(
                "[compose] SMOKE_KEEP_STACK=1 — keeping stack (project:{})",
                self.project
            );
            return;
        }
        down_stack_best_effort(&self.repo, &self.compose_files, &self.project);
    }
}

pub async fn boot_stack() -> Result<BootCtx> {
    let repo = ensure_hippius_repo().await?;
    build_hippius_base(&repo).await?;
    build_custom_ipfs_image(&repo).await?;
    ensure_repo_env_files(&repo)?;
    ensure_external_networks()?;

    let gateway_port = choose_free_port()?;
    let s3_endpoint = format!("http://127.0.0.1:{gateway_port}");

    let compose_files = prepare_compose_files(&repo, gateway_port).await?;
    let project = up_stack_multi(&repo, &compose_files).await?;

    // If anything fails after this point, ensure we don't leak containers.
    let early_guard = ComposeTeardownGuard::new(&repo, &compose_files, &project);

    wait_for_gateway_ready(
        "127.0.0.1",
        gateway_port,
        Duration::from_secs(150),
        &repo,
        &compose_files,
        &project,
    )
    .await?;

    // Boot succeeded — BootCtx::Drop will handle teardown from now on.
    early_guard.disarm();

    Ok(BootCtx {
        repo,
        compose_files,
        project,
        gateway_port,
        s3_endpoint,
    })
}

pub async fn teardown_stack(boot: &BootCtx) -> Result<()> {
    down_stack_multi(&boot.repo, &boot.compose_files, &boot.project).await
}

pub async fn new_bucket(s3c: &s3::Client) -> Result<String> {
    let bucket = format!("itest-{}", Uuid::new_v4().simple());
    s3c.create_bucket().bucket(&bucket).send().await?;
    s3c.put_object()
        .bucket(&bucket)
        .key("preflight.txt")
        .body(ByteStream::from_static(b"ok"))
        .content_length(2)
        .send()
        .await
        .context("preflight PutObject failed")?;
    Ok(bucket)
}

/* ---- Pull/clone repo (fresh‑clone safe) ---- */

async fn ensure_hippius_repo() -> Result<PathBuf> {
    // 1) Respect explicit override
    if let Ok(d) = std::env::var("HIPPIUS_S3_DIR") {
        let p = Path::new(&d);
        anyhow::ensure!(
            p.join(".git").exists(),
            "HIPPIUS_S3_DIR is not a git repo: {d}"
        );
        return Ok(p.canonicalize()?);
    }

    // 2) Always use a private throwaway clone under target/itest/hippius-s3
    let target = Path::new("target/itest/hippius-s3");
    let desired_ref = std::env::var("HIPPIUS_S3_REF").ok();

    if !target.exists() {
        fs::create_dir_all(
            target
                .parent()
                .ok_or_else(|| anyhow!("missing parent dir"))?,
        )?;
        let st = Command::new("git")
            .args([
                "clone",
                "--depth=1",
                "https://github.com/thenervelab/hippius-s3",
                target.to_str().unwrap(),
            ])
            .status()
            .context("git clone thenervelab/hippius-s3")?;
        if !st.success() {
            anyhow::bail!("failed to clone thenervelab/hippius-s3");
        }
    }

    git_fetch_reset(target, desired_ref.as_deref())?;
    Ok(target.canonicalize()?)
}

fn git_fetch_reset(dir: &Path, r: Option<&str>) -> Result<()> {
    // No 'remote set-url' here; only operate inside the throwaway clone.
    let st = Command::new("git")
        .current_dir(dir)
        .args(["fetch", "--tags", "--prune", "origin"])
        .status()
        .context("git fetch")?;
    if !st.success() {
        anyhow::bail!("git fetch failed in {}", dir.display());
    }

    if let Some(refname) = r {
        let st = Command::new("git")
            .current_dir(dir)
            .args(["checkout", "-B", "itest", refname])
            .status()
            .context("git checkout ref")?;
        if !st.success() {
            anyhow::bail!("git checkout {} failed", refname);
        }
        let st = Command::new("git")
            .current_dir(dir)
            .args(["reset", "--hard", refname])
            .status()
            .context("git reset --hard ref")?;
        if !st.success() {
            anyhow::bail!("git reset --hard {} failed", refname);
        }
    } else {
        let st = Command::new("git")
            .current_dir(dir)
            .args(["checkout", "-B", "main", "origin/main"])
            .status()
            .context("git checkout origin/main")?;
        if !st.success() {
            anyhow::bail!("git checkout origin/main failed");
        }
        let st = Command::new("git")
            .current_dir(dir)
            .args(["reset", "--hard", "origin/main"])
            .status()
            .context("git reset --hard origin/main")?;
        if !st.success() {
            anyhow::bail!("git reset --hard origin/main failed");
        }
    }
    Ok(())
}

fn docker_image_exists(tag: &str) -> bool {
    Command::new("docker")
        .args(["image", "inspect", tag])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn build_hippius_base(repo_dir: &Path) -> Result<()> {
    let force = std::env::var("HIPPIUS_S3_FORCE_REBUILD")
        .map(|v| v == "1")
        .unwrap_or(false);
    if !force && docker_image_exists("hippius-s3-base:latest") {
        eprintln!("[build] reuse hippius-s3-base:latest");
        return Ok(());
    }
    let st = Command::new("docker")
        .current_dir(repo_dir)
        .args([
            "build",
            "-f",
            "Dockerfile.base",
            "-t",
            "hippius-s3-base:latest",
            ".",
        ])
        .status()
        .context("build base image")?;
    if !st.success() {
        anyhow::bail!("failed to build hippius-s3-base:latest");
    }
    Ok(())
}

async fn build_custom_ipfs_image(repo_dir: &Path) -> Result<()> {
    let force = std::env::var("HIPPIUS_S3_FORCE_REBUILD")
        .map(|v| v == "1")
        .unwrap_or(false);
    if !force && docker_image_exists("hippius-itest-ipfs:latest") {
        eprintln!("[build] reuse hippius-itest-ipfs:latest");
        return Ok(());
    }

    let ipfs_dir = repo_dir.join("itest-ipfs");
    if !ipfs_dir.exists() {
        fs::create_dir_all(&ipfs_dir)?;
    }
    let script = r#"#!/bin/sh
set -e
ipfs config --json Addresses.API '"/ip4/0.0.0.0/tcp/5001"'
ipfs config --json Addresses.Gateway '"/ip4/0.0.0.0/tcp/8080"'
"#;
    fs::write(ipfs_dir.join("001-bind.sh"), script)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut p = fs::metadata(ipfs_dir.join("001-bind.sh"))?.permissions();
        p.set_mode(0o755);
        fs::set_permissions(ipfs_dir.join("001-bind.sh"), p)?;
    }

    let dockerfile = r#"FROM ipfs/kubo:v0.38.1
COPY itest-ipfs/001-bind.sh /container-init.d/001-bind.sh
RUN chmod +x /container-init.d/001-bind.sh
"#;
    fs::write(repo_dir.join("Dockerfile.ipfs"), dockerfile)?;

    let st = Command::new("docker")
        .current_dir(repo_dir)
        .args([
            "build",
            "-f",
            "Dockerfile.ipfs",
            "-t",
            "hippius-itest-ipfs:latest",
            ".",
        ])
        .status()
        .context("build ipfs image")?;
    if !st.success() {
        anyhow::bail!("failed to build hippius-itest-ipfs:latest");
    }
    Ok(())
}

fn choose_free_port() -> Result<u16> {
    let s = TcpListener::bind("127.0.0.1:0")?;
    Ok(s.local_addr()?.port())
}

/* -------- Compose chain (Windows-safe) -------- */

async fn write_sanitized_compose(repo_dir: &Path, gateway_host_port: u16) -> Result<PathBuf> {
    let yaml = format!(
        r#"
services:
  db:
    image: postgres:15
    environment:
      POSTGRES_DB: hippius
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d hippius"]
      interval: 5s
      timeout: 3s
      retries: 60

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    healthcheck:
      test: ["CMD", "redis-cli", "PING"]
      interval: 5s
      timeout: 3s
      retries: 60

  redis-accounts:
    image: redis:7-alpine
    command:
      [
        "redis-server",
        "--save",
        "60 1",
        "--save",
        "300 10",
        "--save",
        "900 100",
        "--appendonly",
        "yes",
        "--appendfsync",
        "everysec",
      ]
    healthcheck:
      test: ["CMD", "redis-cli", "PING"]
      interval: 5s
      timeout: 3s
      retries: 60

  redis-chain:
    image: redis:7-alpine
    command:
      [
        "redis-server",
        "--save",
        "60 1",
        "--save",
        "300 10",
        "--save",
        "900 100",
        "--appendonly",
        "yes",
        "--appendfsync",
        "everysec",
      ]
    healthcheck:
      test: ["CMD", "redis-cli", "PING"]
      interval: 5s
      timeout: 3s
      retries: 60

  redis-rate-limiting:
    image: redis:7-alpine
    command: ["redis-server", "--maxmemory", "1gb"]
    healthcheck:
      test: ["CMD", "redis-cli", "PING"]
      interval: 5s
      timeout: 3s
      retries: 60

  redis-queues:
    image: redis:7-alpine
    command:
      [
        "redis-server",
        "--maxmemory",
        "2gb",
        "--maxmemory-policy",
        "allkeys-lru",
        "--appendonly",
        "yes",
        "--appendfsync",
        "everysec",
      ]
    healthcheck:
      test: ["CMD", "redis-cli", "PING"]
      interval: 5s
      timeout: 3s
      retries: 60

  ipfs:
    image: hippius-itest-ipfs:latest
    healthcheck:
      test: ["CMD", "ipfs", "id"]
      interval: 5s
      timeout: 5s
      retries: 120

  api:
    build:
      context: .
      dockerfile: Dockerfile
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
      redis-accounts:
        condition: service_healthy
      redis-chain:
        condition: service_healthy
      redis-rate-limiting:
        condition: service_healthy
      redis-queues:
        condition: service_healthy
      ipfs:
        condition: service_started
    env_file:
      - .env.defaults
      - .env
    environment:
      HOST: "0.0.0.0"
      PORT: "8000"
      ENVIRONMENT: "test"
      DEBUG: "false"
      LOG_LEVEL: "INFO"
      ENABLE_API_DOCS: "false"
      ENABLE_MONITORING: "false"
      ENABLE_BANHAMMER: "false"
      HIPPIUS_BYPASS_CREDIT_CHECK: "true"
      PUBLISH_TO_CHAIN: "false"
      HIPPIUS_IPFS_STORE_URL: "http://ipfs:5001"
      HIPPIUS_IPFS_GET_URL: "http://ipfs:8080"
      DATABASE_URL: "postgresql://postgres:postgres@db:5432/hippius?sslmode=disable"
      HIPPIUS_KEYSTORE_DATABASE_URL: "postgresql://postgres:postgres@db:5432/hippius?sslmode=disable"
      REDIS_URL: "redis://redis:6379/0"
      REDIS_ACCOUNTS_URL: "redis://redis-accounts:6379/0"
      REDIS_CHAIN_URL: "redis://redis-chain:6379/0"
      REDIS_RATE_LIMITING_URL: "redis://redis-rate-limiting:6379/0"
      REDIS_QUEUES_URL: "redis://redis-queues:6379/0"
      HIPPIUS_REDIS_CACHE_URL: "redis://redis:6379/0"
      HIPPIUS_REDIS_METRICS_URL: "redis://redis:6379/0"
      HIPPIUS_REDIS_QUEUES_URL: "redis://redis-queues:6379/0"
      HIPPIUS_QUEUE_REDIS_URL: "redis://redis-queues:6379/0"
      QUEUE_REDIS_URL: "redis://redis-queues:6379/0"
      FRONTEND_HMAC_SECRET: "dev-only-frontend-hmac"
      BACKEND_HMAC_SECRET: "dev-only-backend-hmac"
      BACKEND_HMAC_KEY: "local-dev"
      HIPPIUS_API_BASE_URL: "http://api:8000/api"
    entrypoint:
      - /bin/bash
      - -lc
      - |
          set -euo pipefail
          tr -d '\r' </start-api.sh > /tmp/start-api.sh
          chmod +x /tmp/start-api.sh
          mkdir -p /app/db
          ln -sf /app/hippius_s3/sql/migrations /app/db/migrations || true
          export DBMATE_MIGRATIONS_DIR=/app/hippius_s3/sql/migrations
          export MIGDIR=/app/hippius_s3/sql/migrations
          exec /bin/bash /tmp/start-api.sh
    healthcheck:
      test:
        - "CMD"
        - "python"
        - "-c"
        - "import http.client,sys; c=http.client.HTTPConnection('localhost',8000,timeout=2); c.request('GET','/'); r=c.getresponse(); sys.exit(0 if 200 <= r.status < 500 else 1)"
      interval: 10s
      timeout: 5s
      retries: 60
      start_period: 20s
    ports: []

  gateway:
    build:
      context: .
      dockerfile: gateway/Dockerfile
    working_dir: /app
    depends_on:
      api:
        condition: service_healthy
      downloader:
        condition: service_started
      uploader:
        condition: service_started
    command:
      - "/bin/bash"
      - "-lc"
      - |
          set -euo pipefail
          tr -d '\r' </app/gateway/start-gateway.sh > /tmp/start-gateway.sh
          chmod +x /tmp/start-gateway.sh
          exec /bin/bash /tmp/start-gateway.sh
    env_file:
      - .env.defaults
      - .env
    environment:
      GATEWAY_BACKEND_URL: "http://api:8000"
      GATEWAY_PORT: "8080"
      HIPPIUS_BYPASS_CREDIT_CHECK: "true"
      ENABLE_BANHAMMER: "false"
      FRONTEND_HMAC_SECRET: "dev-only-frontend-hmac"
    healthcheck:
      test:
        - "CMD"
        - "python"
        - "-c"
        - "import http.client,sys; c=http.client.HTTPConnection('localhost',8080,timeout=2); c.request('GET','/health'); r=c.getresponse(); sys.exit(0 if 200 <= r.status < 500 else 1)"
      interval: 10s
      timeout: 5s
      retries: 60
      start_period: 20s
    ports:
      - "127.0.0.1:{gateway_host_port}:8080"

  uploader:
    build:
      context: .
      dockerfile: workers/Dockerfile
    env_file:
      - .env.defaults
      - .env
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
      redis-queues:
        condition: service_healthy
      ipfs:
        condition: service_started
    environment:
      WORKER_SCRIPT: workers/run_uploader_in_loop.py
      ENABLE_WATCHFILES: "false"

  downloader:
    build:
      context: .
      dockerfile: workers/Dockerfile
    env_file:
      - .env.defaults
      - .env
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
      redis-queues:
        condition: service_healthy
    environment:
      WORKER_SCRIPT: workers/run_downloader_in_loop.py
      ENABLE_WATCHFILES: "false"

  unpinner:
    build:
      context: .
      dockerfile: workers/Dockerfile
    env_file:
      - .env.defaults
      - .env
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
      redis-queues:
        condition: service_healthy
    environment:
      WORKER_SCRIPT: workers/run_unpinner_in_loop.py
      ENABLE_WATCHFILES: "false"

  janitor:
    build:
      context: .
      dockerfile: workers/Dockerfile
    env_file:
      - .env.defaults
      - .env
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      WORKER_SCRIPT: workers/run_janitor_in_loop.py
      ENABLE_WATCHFILES: "false"

  account-cacher:
    build:
      context: .
      dockerfile: workers/Dockerfile
    env_file:
      - .env.defaults
      - .env
    depends_on:
      redis-accounts:
        condition: service_healthy
    environment:
      WORKER_SCRIPT: workers/run_account_cacher_in_loop.py
      ENABLE_WATCHFILES: "false"
"#,
    );
    let path = repo_dir.join("docker-compose.sanitized.yml");
    std::fs::write(&path, yaml).context("write compose")?;
    Ok(path)
}

// Count leading spaces
#[cfg(windows)]
fn indent_of(s: &str) -> usize {
    s.as_bytes().iter().take_while(|&&c| c == b' ').count()
}

// Windows-only: sanitize redis.conf mounts and keep `volumes:` a list (or `[]` if empty)
#[cfg(windows)]
fn sanitize_redis_conf_mounts(input: &Path) -> Result<PathBuf> {
    let src = fs::read_to_string(input)
        .with_context(|| format!("read compose file {}", input.display()))?;
    let lines: Vec<String> = src.lines().map(|s| s.to_string()).collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());

    let mut i = 0usize;
    while i < lines.len() {
        let line = &lines[i];
        let t = line.trim_start();

        if t.starts_with("volumes:") {
            let vol_indent = indent_of(line);
            let mut j = i + 1;
            while j < lines.len() {
                let tj = lines[j].trim_start();
                let indj = indent_of(&lines[j]);
                let is_comment = tj.starts_with('#');
                let is_blank = tj.is_empty();
                let is_new_key =
                    indj <= vol_indent && !tj.starts_with('-') && !is_comment && !is_blank;
                if is_new_key {
                    break;
                }
                j += 1;
            }

            let mut k = i + 1;
            let mut keep_blocks: Vec<(usize, usize)> = Vec::new();

            while k < j {
                let tk = lines[k].trim_start();
                if tk.starts_with('-') {
                    let item_indent = indent_of(&lines[k]);
                    let mut m = k + 1;
                    while m < j {
                        let tm = lines[m].trim_start();
                        let im = indent_of(&lines[m]);
                        if im == item_indent && tm.starts_with('-') {
                            break;
                        }
                        m += 1;
                    }
                    let item_text = lines[k..m].join("\n");
                    let mentions_redis_conf = item_text.contains("/usr/local/etc/redis/redis.conf")
                        || item_text.contains("./redis.conf")
                        || item_text.contains("redis.conf:");
                    if !mentions_redis_conf {
                        keep_blocks.push((k, m));
                    }
                    k = m;
                } else {
                    k += 1;
                }
            }

            if keep_blocks.is_empty() {
                out.push(format!("{}volumes: []", " ".repeat(vol_indent)));
            } else {
                out.push(line.clone());
                for (s, e) in keep_blocks {
                    out.extend_from_slice(&lines[s..e]);
                }
            }

            i = j;
            continue;
        }

        out.push(line.clone());
        i += 1;
    }

    let parent = input.parent().unwrap_or_else(|| Path::new("."));
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "docker-compose".to_string());
    let ext = input
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "yml".to_string());
    let out_path = parent.join(format!("{stem}.win-noredis.{ext}"));

    fs::write(&out_path, out.join("\n"))
        .with_context(|| format!("write sanitized compose {}", out_path.display()))?;
    eprintln!(
        "[compose] sanitized redis.conf mounts for Windows: {} -> {}",
        input.display(),
        out_path.display()
    );
    Ok(out_path)
}

async fn prepare_compose_files(repo_dir: &Path, gateway_host_port: u16) -> Result<Vec<PathBuf>> {
    let base = repo_dir.join("docker-compose.yml");
    let e2e = repo_dir.join("docker-compose.e2e.yml");

    if base.exists() && e2e.exists() {
        let (use_base, use_e2e) = {
            #[cfg(windows)]
            {
                (
                    sanitize_redis_conf_mounts(&base)?,
                    sanitize_redis_conf_mounts(&e2e)?,
                )
            }
            #[cfg(not(windows))]
            {
                (base.clone(), e2e.clone())
            }
        };

        let override_port = repo_dir.join("docker-compose.itest.override.yml");
        let yaml_port = format!(
            r#"
services:
  gateway:
    ports:
      - "127.0.0.1:{gateway_host_port}:8080"
  api:
    ports: []
  db:
    ports: []
  ipfs:
    ports: []
  redis:
    ports: []
  redis-accounts:
    ports: []
  redis-chain:
    ports: []
  redis-rate-limiting:
    ports: []
  redis-queues:
    ports: []
  mock-hippius-api:
    ports: []
  toxiproxy:
    ports: []
"#
        );
        fs::write(&override_port, yaml_port)?;

        if compose_validate(
            repo_dir,
            &[use_base.clone(), use_e2e.clone(), override_port.clone()],
        ) {
            return Ok(vec![use_base, use_e2e, override_port]);
        } else {
            eprintln!("[compose] validation failed; falling back to sanitized compose");
            let single = write_sanitized_compose(repo_dir, gateway_host_port).await?;
            return Ok(vec![single]);
        }
    } else {
        let single = write_sanitized_compose(repo_dir, gateway_host_port).await?;
        Ok(vec![single])
    }
}

fn compose_env_defaults() -> Vec<(&'static str, &'static str)> {
    vec![
        ("FRONTEND_HMAC_SECRET", "x"),
        ("BACKEND_HMAC_SECRET", "x"),
        ("BACKEND_HMAC_KEY", "x"),
        ("HOST_BIND_IP", "127.0.0.1"),
        ("RATE_LIMIT_ENABLED", "false"),
        ("RATE_LIMIT_PER_MINUTE", "60000"),
        ("RATE_LIMIT_BURST", "60000"),
        ("HIPPIUS_SUBSTRATE_URL", "ws://127.0.0.1:9944"),
        ("REDIS_URL", "redis://redis:6379/0"),
        ("REDIS_ACCOUNTS_URL", "redis://redis:6379/0"),
        ("REDIS_CHAIN_URL", "redis://redis:6379/1"),
        ("REDIS_RATE_LIMITING_URL", "redis://redis:6379/2"),
        ("REDIS_QUEUES_URL", "redis://redis:6379/3"),
        ("REDIS_CACHE_URL", "redis://redis:6379/4"),
        ("REDIS_METRICS_URL", "redis://redis:6379/0"),
        ("HIPPIUS_REDIS_CACHE_URL", "redis://redis:6379/4"),
        ("HIPPIUS_REDIS_METRICS_URL", "redis://redis:6379/0"),
        ("HIPPIUS_REDIS_QUEUES_URL", "redis://redis:6379/3"),
        ("QUEUE_REDIS_URL", "redis://redis:6379/3"),
        ("HIPPIUS_QUEUE_REDIS_URL", "redis://redis:6379/3"),
        ("CACHET_API_URL", "http://cachet.invalid"),
        ("CACHET_API_KEY", "dev-key"),
    ]
}

fn compose_validate(repo_dir: &Path, files: &[PathBuf]) -> bool {
    let (prog, prefix) = match find_compose() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let mut cmd = Command::new(&prog);
    cmd.current_dir(repo_dir);
    #[cfg(windows)]
    {
        cmd.env("COMPOSE_CONVERT_WINDOWS_PATHS", "1");
    }
    for (k, v) in compose_env_defaults() {
        cmd.env(k, v);
    }
    for p in prefix.iter() {
        cmd.arg(p);
    }
    for f in files {
        cmd.arg("-f").arg(f);
    }
    cmd.arg("config").arg("-q");
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn compose_cmd_multi(repo_dir: &Path, files: &[PathBuf], extra: &[&str]) -> Command {
    let (prog, prefix) = find_compose().expect("docker compose not found");
    let mut cmd = Command::new(&prog);
    cmd.current_dir(repo_dir);

    #[cfg(windows)]
    {
        cmd.env("COMPOSE_CONVERT_WINDOWS_PATHS", "1");
    }
    for (k, v) in compose_env_defaults() {
        cmd.env(k, v);
    }

    for p in prefix.iter() {
        cmd.arg(p);
    }
    for f in files {
        cmd.arg("-f");
        cmd.arg(f.to_str().expect("compose path"));
    }
    for a in extra {
        cmd.arg(a);
    }
    cmd
}

fn find_compose() -> Result<(String, Vec<String>)> {
    if let Ok(st) = Command::new("docker").args(["compose", "version"]).status() {
        if st.success() {
            return Ok(("docker".into(), vec!["compose".into()]));
        }
    }
    if let Ok(st) = Command::new("docker-compose").arg("--version").status() {
        if st.success() {
            return Ok(("docker-compose".into(), vec![]));
        }
    }
    anyhow::bail!("need Docker Compose (V2 or classic)")
}

async fn up_stack_multi(repo_dir: &Path, files: &[PathBuf]) -> Result<String> {
    let project = format!("hippius_itest_{}", Uuid::new_v4().simple());
    let do_build = std::env::var("HIPPIUS_S3_BUILD")
        .map(|v| v == "1")
        .unwrap_or(false);

    if do_build {
        let st_build = compose_cmd_multi(
            repo_dir,
            files,
            &["--project-name", &project, "build", "api"],
        )
        .status()?;
        if !st_build.success() {
            anyhow::bail!("docker compose build api failed");
        }
    } else {
        eprintln!("[compose] skipping build (use HIPPIUS_S3_BUILD=1 to build)");
    }

    let st_up =
        compose_cmd_multi(repo_dir, files, &["--project-name", &project, "up", "-d"]).status()?;
    if !st_up.success() {
        anyhow::bail!("docker compose up failed");
    }
    Ok(project)
}

async fn down_stack_multi(repo_dir: &Path, files: &[PathBuf], project: &str) -> Result<()> {
    let _ = compose_cmd_multi(
        repo_dir,
        files,
        &["--project-name", project, "down", "--volumes"],
    )
    .status();
    Ok(())
}

async fn wait_for_gateway_ready(
    host: &str,
    port: u16,
    timeout: Duration,
    repo_dir: &Path,
    compose_files: &[PathBuf],
    project: &str,
) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let deadline = time::Instant::now() + timeout;
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
    );

    loop {
        match tokio::net::TcpStream::connect((host, port)).await {
            Ok(mut stream) => {
                let _ = stream.write_all(req.as_bytes()).await;
                let mut buf = vec![0u8; 1024];
                if let Ok(n) = stream.read(&mut buf).await {
                    if n > 0 {
                        if let Some(code) = parse_http_status(&String::from_utf8_lossy(&buf[..n])) {
                            if (200..=299).contains(&code) {
                                eprintln!("[ready] hippius gateway responded with HTTP {}", code);
                                return Ok(());
                            }
                        }
                    }
                }
            }
            Err(_) => {}
        }
        if time::Instant::now() >= deadline {
            let _ = compose_cmd_multi(
                repo_dir,
                compose_files,
                &["--project-name", project, "logs", "--tail=200", "gateway"],
            )
            .status();
            let _ = compose_cmd_multi(
                repo_dir,
                compose_files,
                &["--project-name", project, "logs", "--tail=200", "api"],
            )
            .status();
            let _ = compose_cmd_multi(
                repo_dir,
                compose_files,
                &["--project-name", project, "ps"],
            )
            .status();
            anyhow::bail!("hippius gateway didn't become ready");
        }
        time::sleep(Duration::from_millis(350)).await;
    }
}

fn parse_http_status(head: &str) -> Option<i32> {
    let mut lines = head.lines();
    let status_line = lines.next()?;
    let parts: Vec<&str> = status_line.split_whitespace().collect();
    if parts.len() >= 2 {
        return parts[1].parse::<i32>().ok();
    }
    None
}

// .env provisioning (prefers .env.test-base)
fn ensure_repo_env_files(repo_dir: &Path) -> Result<()> {
    let dot_env = repo_dir.join(".env");
    let test_base = repo_dir.join(".env.test-base");
    let test_docker = repo_dir.join(".env.test-docker");
    let example = repo_dir.join(".env.example");

    if !dot_env.exists() {
        if test_base.exists() {
            fs::copy(&test_base, &dot_env)
                .with_context(|| format!("copy {} -> .env", test_base.display()))?;
            eprintln!("[env] created .env from .env.test-base");
        } else if test_docker.exists() {
            fs::copy(&test_docker, &dot_env)
                .with_context(|| format!("copy {} -> .env", test_docker.display()))?;
            eprintln!("[env] created .env from .env.test-docker");
        } else if example.exists() {
            fs::copy(&example, &dot_env)
                .with_context(|| format!("copy {} -> .env", example.display()))?;
            eprintln!("[env] created .env from .env.example");
        } else {
            anyhow::bail!(
                "No env template found in {}; expected .env.test-base / .env.test-docker / .env.example",
                repo_dir.display()
            );
        }
    } else {
        eprintln!("[env] using existing .env");
    }

    if !test_docker.exists() && dot_env.exists() {
        let _ = fs::copy(&dot_env, &test_docker);
    }
    if !test_base.exists() && dot_env.exists() {
        let _ = fs::copy(&dot_env, &test_base);
    }
    Ok(())
}

// Ensure external networks (e2e may declare 'hippius_net' as external)
fn ensure_external_networks() -> Result<()> {
    for name in &["hippius_net"] {
        if !docker_network_exists(name) {
            eprintln!("[docker] creating external network: {name}");
            let st = Command::new("docker")
                .args(["network", "create", name])
                .status()
                .context("docker network create")?;
            if !st.success() {
                anyhow::bail!("failed to create external docker network: {name}");
            }
        }
    }
    Ok(())
}
fn docker_network_exists(name: &str) -> bool {
    Command::new("docker")
        .args(["network", "inspect", name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/* ----------------- Wave/prefix helpers + sanity assertions ----------------- */

/// List remote keys under 'pair/' that start with a given prefix.
pub async fn list_remote_keys_with_prefix(
    s3c: &s3::Client,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<String>> {
    let all = list_remote_pair_keys(s3c, bucket).await?;
    Ok(all.into_iter().filter(|k| k.starts_with(prefix)).collect())
}

/// Assert that the number of remote keys with `prefix` exactly equals `expected`.
pub async fn assert_remote_count_for_prefix(
    s3c: &s3::Client,
    bucket: &str,
    prefix: &str,
    expected: usize,
) -> Result<()> {
    let got = list_remote_keys_with_prefix(s3c, bucket, prefix).await?;
    anyhow::ensure!(
        got.len() == expected,
        "remote count for prefix '{}' expected {}, got {} (examples: {:?})",
        prefix,
        expected,
        got.len(),
        &got[..got.len().min(8)]
    );
    Ok(())
}

/// Assert UploadOnly conflict rename semantics (name-sensitive):
/// After a same-name conflict on `original_key`, remote must expose >=2 bodies;
/// each client keeps exactly 1 variant, and exactly one client keeps the original name.
pub async fn assert_upload_only_conflict_local_rename(
    a: &ClientCtx,
    b: &ClientCtx,
    bucket: &str,
    original_key: &str,
    gid: &str,
) -> Result<()> {
    let rv = find_remote_by_gid(&a.s3, bucket, gid).await?;
    anyhow::ensure!(
        distinct_body_count(&rv) >= 2,
        "[UploadOnly] remote must expose >=2 bodies for conflict on {} (gid:{})",
        original_key,
        gid
    );
    let av = find_local_by_gid(&a.local_root, gid)?;
    let bv = find_local_by_gid(&b.local_root, gid)?;
    anyhow::ensure!(
        av.len() == 1 && bv.len() == 1,
        "[UploadOnly] each client must keep exactly 1 variant after conflict (gid:{})",
        gid
    );
    let a_key = &av[0].0;
    let b_key = &bv[0].0;
    let a_is_original = a_key == original_key;
    let b_is_original = b_key == original_key;
    anyhow::ensure!(
        a_is_original ^ b_is_original,
        "[UploadOnly] exactly one client must keep original name after conflict; got A:{:?} B:{:?} (orig:{})",
        a_key,
        b_key,
        original_key
    );
    // Remote must have exactly the two keys present locally (no spurious extra under this gid).
    let rkeys: std::collections::HashSet<_> = rv.iter().map(|(k, _)| k.clone()).collect();
    anyhow::ensure!(
        rkeys.contains(a_key) && rkeys.contains(b_key),
        "[UploadOnly] remote must contain the local variant keys; remote:{:?} A:{}, B:{}",
        rkeys,
        a_key,
        b_key
    );
    Ok(())
}

/// Same-file dual rename performed concurrently (propagating policies):
/// old -> new_a on A, old -> new_b on B. Asserts:
///   - remote has ONLY new_a and new_b (old removed),
///   - both clients keep BOTH new names (old absent).
pub async fn assert_bi_rename_same_file_propagates(
    a: &ClientCtx,
    b: &ClientCtx,
    bucket: &str,
    old_key: &str,
    new_a: &str,
    new_b: &str,
    rounds_after_rename: usize,
    check_iters: usize,
) -> Result<()> {
    // Seed on A and ensure both adopt 'old_key'
    write_one(&a.local_root, old_key, "seed-biren\n").await?;
    sync_until_present_on_both(a, b, &[old_key.to_string()], check_iters).await?;

    // Concurrent rename on same key
    let (ra, rb) = tokio::join!(
        rename_one(&a.local_root, old_key, new_a),
        rename_one(&b.local_root, old_key, new_b)
    );
    ra?;
    rb?;

    for _ in 0..rounds_after_rename {
        sync_both(a, b, 1).await?;
    }

    // Remote: only new_a and new_b
    let remote = list_remote_pair_keys(&a.s3, bucket).await?;
    anyhow::ensure!(
        remote.contains(new_a) && remote.contains(new_b) && !remote.contains(old_key),
        "remote must contain only new names (have new_a:{}, new_b:{}, missing old:{})",
        remote.contains(new_a),
        remote.contains(new_b),
        old_key
    );

    // Locals: both clients have both new names and not old
    for ctx in [a, b] {
        let local = list_local_pair_keys(&ctx.local_root)?;
        anyhow::ensure!(
            local.contains(new_a) && local.contains(new_b) && !local.contains(old_key),
            "client {} must have both new names and not the old one",
            ctx.name
        );
    }

    // Stability: old must not reappear
    for _ in 0..3 {
        sync_both(a, b, 1).await?;
        let rr = list_remote_pair_keys(&a.s3, bucket).await?;
        anyhow::ensure!(
            rr.contains(new_a) && rr.contains(new_b) && !rr.contains(old_key),
            "stability check failed: remote"
        );
    }

    Ok(())
}

// NEW: UploadOnly — single shared-file rename must propagate to remote and peers, no duplicates.
pub async fn assert_shared_rename_propagates_upload_only(
    a: &ClientCtx,
    b: &ClientCtx,
    bucket: &str,
    old_key: &str,
    new_key: &str,
    rounds_after_rename: usize,
    check_iters: usize,
) -> Result<()> {
    // Seed the same object on both clients without conflict
    seed_shared_file_no_conflict_upload_only(a, b, old_key, "seed-shared\n", check_iters).await?;

    // Rename locally on A
    rename_one(&a.local_root, old_key, new_key).await?;

    // Let convergence happen
    for _ in 0..rounds_after_rename {
        sync_both(a, b, 1).await?;
    }

    // Remote: ONLY new name present
    let remote = list_remote_pair_keys(&a.s3, bucket).await?;
    anyhow::ensure!(remote.contains(new_key), "remote must contain {}", new_key);
    anyhow::ensure!(
        !remote.contains(old_key),
        "remote must NOT retain {}",
        old_key
    );

    // Both clients: ONLY new name present
    for ctx in [a, b] {
        let local = list_local_pair_keys(&ctx.local_root)?;
        anyhow::ensure!(
            local.contains(new_key),
            "{} must have {}",
            ctx.name,
            new_key
        );
        anyhow::ensure!(
            !local.contains(old_key),
            "{} must NOT have {}",
            ctx.name,
            old_key
        );
    }

    // Stability
    for _ in 0..3 {
        sync_both(a, b, 1).await?;
        let rr = list_remote_pair_keys(&a.s3, bucket).await?;
        anyhow::ensure!(
            rr.contains(new_key) && !rr.contains(old_key),
            "rename stability failed"
        );
    }
    Ok(())
}

// NEW: UploadOnly — two different shared files renamed independently; both renames propagate, no duplicates.
pub async fn assert_dual_shared_rename_propagates_upload_only(
    a: &ClientCtx,
    b: &ClientCtx,
    bucket: &str,
    old_a: &str,
    new_a: &str,
    old_b: &str,
    new_b: &str,
    rounds_after_rename: usize,
    check_iters: usize,
) -> Result<()> {
    // Seed both files on both clients (identical bodies) to avoid conflict
    seed_shared_file_no_conflict_upload_only(a, b, old_a, "seed-shared\n", check_iters).await?;
    seed_shared_file_no_conflict_upload_only(a, b, old_b, "seed-shared\n", check_iters).await?;

    // Rename concurrently (A handles A's file; B handles B's file)
    let (ra, rb) = tokio::join!(
        rename_one(&a.local_root, old_a, new_a),
        rename_one(&b.local_root, old_b, new_b),
    );
    ra?;
    rb?;

    for _ in 0..rounds_after_rename {
        sync_both(a, b, 1).await?;
    }

    // Remote: ONLY new_a and new_b
    let remote = list_remote_pair_keys(&a.s3, bucket).await?;
    anyhow::ensure!(
        remote.contains(new_a) && remote.contains(new_b),
        "remote must have new names"
    );
    anyhow::ensure!(
        !remote.contains(old_a) && !remote.contains(old_b),
        "remote must drop old names"
    );

    // Both clients: ONLY new_a and new_b
    for ctx in [a, b] {
        let local = list_local_pair_keys(&ctx.local_root)?;
        anyhow::ensure!(
            local.contains(new_a) && local.contains(new_b),
            "{} must have both new names",
            ctx.name
        );
        anyhow::ensure!(
            !local.contains(old_a) && !local.contains(old_b),
            "{} must drop old names",
            ctx.name
        );
    }

    // Stability
    for _ in 0..3 {
        sync_both(a, b, 1).await?;
        let rr = list_remote_pair_keys(&a.s3, bucket).await?;
        anyhow::ensure!(
            rr.contains(new_a) && rr.contains(new_b),
            "stability: remote keeps new names"
        );
        anyhow::ensure!(
            !rr.contains(old_a) && !rr.contains(old_b),
            "stability: remote old names do not reappear"
        );
    }
    Ok(())
}

// NEW: UploadOnly — same-file rename/rename conflict propagates with BOTH new names present;
// the old name must disappear everywhere (remote and both clients).
pub async fn assert_rename_rename_conflict_no_dup_upload_only(
    a: &ClientCtx,
    b: &ClientCtx,
    bucket: &str,
    old_key: &str,
    new_a: &str,
    new_b: &str,
    rounds_after_rename: usize,
    check_iters: usize,
) -> Result<()> {
    // Seed shared file on both clients (identical body)
    seed_shared_file_no_conflict_upload_only(a, b, old_key, "seed-shared\n", check_iters).await?;

    // Concurrent conflicting renames
    let (ra, rb) = tokio::join!(
        rename_one(&a.local_root, old_key, new_a),
        rename_one(&b.local_root, old_key, new_b),
    );
    ra?;
    rb?;

    for _ in 0..rounds_after_rename {
        sync_both(a, b, 1).await?;
    }

    // Remote must contain BOTH new names and NOT the old
    let remote = list_remote_pair_keys(&a.s3, bucket).await?;
    anyhow::ensure!(
        remote.contains(new_a) && remote.contains(new_b),
        "[UploadOnly] remote must contain both new names after rename/rename ({}, {})",
        new_a,
        new_b
    );
    anyhow::ensure!(
        !remote.contains(old_key),
        "[UploadOnly] remote must NOT retain old name {} after rename/rename",
        old_key
    );

    // Both clients must contain BOTH new names and NOT the old
    for ctx in [a, b] {
        let local = list_local_pair_keys(&ctx.local_root)?;
        anyhow::ensure!(
            local.contains(new_a) && local.contains(new_b),
            "[UploadOnly] {} must have both new names ({}, {})",
            ctx.name,
            new_a,
            new_b
        );
        anyhow::ensure!(
            !local.contains(old_key),
            "[UploadOnly] {} must NOT have old name {}",
            ctx.name,
            old_key
        );
    }

    // Stability: keep only the two new names; old must not reappear
    for _ in 0..3 {
        sync_both(a, b, 1).await?;
        let rr = list_remote_pair_keys(&a.s3, bucket).await?;
        anyhow::ensure!(
            rr.contains(new_a) && rr.contains(new_b) && !rr.contains(old_key),
            "[UploadOnly] stability failed: remote set must be exactly the two new names"
        );
    }

    Ok(())
}
