use anyhow::{Result, anyhow};
use aws_sdk_s3::Client;
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::operation::get_object::GetObjectError;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::ObjectCannedAcl;
use hex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs as tokio_fs;
use tokio::time::{Duration, sleep};

/* =============================== Policy ===================================== */

#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeletePolicy {
    MirrorLocalDeletes,
    RestoreFromRemote,
    LocalOnlyDeletes, // “remote-backup”: deletes are local-only
    UploadOnly,       // no downloads for new keys; conflict => rename local + upload conflict
}

/* ============================ Manifest & Prunefile ========================== */

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct FileMeta {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub etag: String,
    #[serde(default)]
    pub cid: String,
    #[serde(default)]
    pub deletion_count: u32,
    #[serde(default)]
    pub resurrection_count: u32,
    #[serde(default)]
    pub renamed_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Manifest {
    pub entries: HashMap<String, FileMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct PruneEntry {
    #[serde(default)]
    pub present: bool,
    #[serde(default)]
    pub cid: String,
    #[serde(default)]
    pub deletion_count: u32,
    #[serde(default)]
    pub resurrection_count: u32,
    #[serde(default)]
    pub adopted_remote_etag: Option<String>,
    // explicit local delete intent: blocks LOD re-downloads until recreated locally
    #[serde(default)]
    pub locally_deleted: bool,

    // per-file delete policy override; None => use global DeletePolicy
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_deletion_policy: Option<DeletePolicy>,

    // content id we last *adopted from remote* on this client (set on successful
    // upload verification or download/adopt).
    #[serde(default)]
    pub last_adopted_cid: String,
}

pub type PrunedMap = HashMap<String, PruneEntry>;

/* =============================== Constants ================================== */

pub const MANIFEST_ROOT: &str = ".hippius_manifest_v1";
pub const MANIFEST_FOLDER: &str = ".hippius_manifest_v1/";
pub const MANIFEST_KEY: &str = ".hippius_manifest_v1/sync_state.json";
#[allow(dead_code)]
pub const TRASH_PREFIX: &str = ".hippius_manifest_v1/.trash_v0/";

// S3 user metadata key used to store the *previous* content id for an object.
// S3 will expose this as `metadata()["hippius_prev_cid"]` on GET.
const META_PREV_CID_KEY: &str = "hippius_prev_cid";

/* ============================ Storage keys ================================== */

pub fn pruned_key_for(prunefile_id: &str) -> String {
    format!("{}/clients/{}/pruned.json", MANIFEST_ROOT, prunefile_id)
}

pub fn prunefile_id(sub_account: &str, path_hash: &str, private: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(sub_account.as_bytes());
    hasher.update(b":");
    hasher.update(path_hash.as_bytes());
    hasher.update(b":");
    hasher.update(private.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

/* ============================= Retry helpers ================================ */

const OP_MAX_RETRIES: usize = 5;
const OP_BASE_BACKOFF_MS: u64 = 75;

#[inline]
fn is_retryable_service_code(code: u16) -> bool {
    (500..600).contains(&code) || code == 429 || code == 408 || code == 403
}

#[inline]
fn is_retryable_sdk_error<E>(e: &SdkError<E>) -> bool {
    match e {
        SdkError::ServiceError(se) => is_retryable_service_code(se.raw().status().as_u16()),
        SdkError::DispatchFailure(_) => true,
        SdkError::TimeoutError(_) => true,
        _ => false,
    }
}

async fn backoff_attempt(attempt: usize) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let jitter = now_ms % 31;
    let delay = (OP_BASE_BACKOFF_MS * (1u64 << attempt)).min(1500) + jitter;
    sleep(Duration::from_millis(delay)).await;
}

async fn small_jitter_backoff() {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let delay = 50 + (now_ms % 151);
    sleep(Duration::from_millis(delay)).await;
}

/* ============================ Small helpers ================================= */

#[inline]
fn normalize_etag(s: &str) -> String {
    let t = s.trim();
    let t = t.strip_prefix("W/").unwrap_or(t).trim();
    t.trim_matches('"').to_string()
}

#[inline]
fn is_deleted(del: u32, res: u32) -> bool {
    del > res
}

#[inline]
fn is_ignored_key(path: &str) -> bool {
    if let Some(name) = Path::new(path).file_name().and_then(|s| s.to_str()) {
        let n = name.to_ascii_lowercase();
        return n == ".ds_store" || n == "thumbs.db";
    }
    false
}

#[inline]
fn client_tag8_from(prunefile_id: &str) -> String {
    let mut tag: String = prunefile_id.chars().take(8).collect();
    if tag.is_empty() {
        tag = "noclient".into();
    }
    tag
}

/* ============================== Local scanning ============================== */

fn rel_key(root: &Path, p: &Path) -> Option<String> {
    p.strip_prefix(root)
        .ok()
        .map(|rp| rp.to_string_lossy().replace('\\', "/"))
}

fn sha256_file(p: &Path) -> io::Result<String> {
    let mut f = fs::File::open(p)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn visit_dir(map: &mut HashMap<String, FileMeta>, root: &Path, dir: &Path) -> io::Result<()> {
    if let Some(rel) = rel_key(root, dir) {
        if rel.starts_with(MANIFEST_FOLDER) || rel == MANIFEST_ROOT {
            return Ok(());
        }
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            visit_dir(map, root, &p)?;
        } else if p.is_file() {
            if let Some(key) = rel_key(root, &p) {
                if key.starts_with(MANIFEST_FOLDER) || is_ignored_key(&key) {
                    continue;
                }
                let cid = sha256_file(&p).unwrap_or_default();
                map.insert(
                    key.clone(),
                    FileMeta {
                        path: key,
                        etag: String::new(),
                        cid,
                        deletion_count: 0,
                        resurrection_count: 0,
                        renamed_to: None,
                    },
                );
            }
        }
    }
    Ok(())
}

async fn scan_local(root: &str) -> Result<HashMap<String, FileMeta>> {
    let root = root.to_string();
    tokio::task::spawn_blocking(move || {
        let mut map = HashMap::new();
        let rootp = Path::new(&root);
        if rootp.exists() {
            visit_dir(&mut map, rootp, rootp)?;
        }
        Ok::<_, io::Error>(map)
    })
    .await?
    .map_err(|e| anyhow!("walk local failed: {e}"))
}

/* =============================== S3 I/O ===================================== */

async fn load_manifest(client: &Client, bucket: &str) -> Result<(Manifest, Option<String>)> {
    match client
        .get_object()
        .bucket(bucket)
        .key(MANIFEST_KEY)
        .send()
        .await
    {
        Ok(obj) => {
            let mut body = obj.body.collect().await?.to_vec();
            const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
            if body.starts_with(BOM) {
                body.drain(..BOM.len());
            }
            if body.is_empty() {
                return Ok((Manifest::default(), obj.e_tag.map(|e| normalize_etag(&e))));
            }
            let m: Manifest = serde_json::from_slice(&body).map_err(|e| {
                anyhow!(
                    "manifest load failed: invalid JSON ({} bytes): {e}",
                    body.len()
                )
            })?;
            Ok((m, obj.e_tag.map(|e| normalize_etag(&e))))
        }
        Err(SdkError::ServiceError(ref se)) => {
            let code = se.raw().status().as_u16();
            if code == 403 {
                return Ok((Manifest::default(), None));
            }
            match se.err() {
                GetObjectError::NoSuchKey(_) => Ok((Manifest::default(), None)),
                other => Err(anyhow!("manifest load failed: {other:?}"))?,
            }
        }
        Err(e) => Err(anyhow!("manifest load failed: {e:?}"))?,
    }
}

async fn save_manifest_cas(
    client: &Client,
    bucket: &str,
    manifest: &Manifest,
    previous_etag: Option<&str>,
) -> Result<(bool, Option<String>)> {
    println!("[Sync] trying to upload manifest to S3");
    let body_bytes = serde_json::to_vec_pretty(manifest)?;
    let mut req = client
        .put_object()
        .bucket(bucket)
        .key(MANIFEST_KEY)
        .body(ByteStream::from(body_bytes));
    req = if let Some(etag) = previous_etag {
        req.if_match(etag)
    } else {
        req.if_none_match("*")
    };
    match req.send().await {
        Ok(out) => Ok((true, out.e_tag.map(|e| normalize_etag(&e)))),
        Err(SdkError::ServiceError(ref se)) if se.raw().status().as_u16() == 412 => {
            Ok((false, None))
        }
        Err(e) => Err(anyhow!("manifest save failed: {e:?}")),
    }
}

/* ---- Robust remote listing with retries on 403/5xx/429 ---- */
async fn list_remote(client: &Client, bucket: &str) -> Result<HashMap<String, FileMeta>> {
    let mut attempt = 0usize;
    loop {
        let mut out = HashMap::new();
        let mut token: Option<String> = None;
        let mut page_ok = true;

        loop {
            let mut req = client.list_objects_v2().bucket(bucket).max_keys(1000);
            if let Some(t) = &token {
                req = req.continuation_token(t);
            }

            match req.send().await {
                Ok(resp) => {
                    if let Some(contents) = resp.contents {
                        for obj in contents {
                            if let Some(key) = obj.key {
                                if key == MANIFEST_KEY || key.starts_with(MANIFEST_FOLDER) {
                                    continue;
                                }
                                if is_ignored_key(&key) {
                                    continue;
                                }
                                out.insert(
                                    key.clone(),
                                    FileMeta {
                                        path: key.clone(),
                                        etag: obj
                                            .e_tag
                                            .map(|e| normalize_etag(&e))
                                            .unwrap_or_default(),
                                        cid: String::new(),
                                        deletion_count: 0,
                                        resurrection_count: 0,
                                        renamed_to: None,
                                    },
                                );
                            }
                        }
                    }
                    if resp.is_truncated.unwrap_or(false) {
                        token = resp.next_continuation_token;
                        continue;
                    }
                    break;
                }
                Err(e) => {
                    page_ok = false;
                    if let SdkError::ServiceError(se) = &e {
                        if is_retryable_service_code(se.raw().status().as_u16()) {
                            break;
                        }
                    }
                    if is_retryable_sdk_error(&e) {
                        break;
                    }
                    return Err(anyhow!("list_remote failed: {e:?}"));
                }
            }
        }

        if page_ok {
            return Ok(out);
        }
        if attempt + 1 >= OP_MAX_RETRIES {
            return Err(anyhow!("list_remote failed persistently (ban/timeout)"));
        }
        backoff_attempt(attempt).await;
        attempt += 1;
    }
}

async fn get_object_bytes_with_retries(
    client: &Client,
    bucket: &str,
    key: &str,
) -> Result<(Vec<u8>, Option<String>, Option<String>)> {
    let mut attempt = 0;
    loop {
        match client.get_object().bucket(bucket).key(key).send().await {
            Ok(obj) => {
                let et = obj.e_tag.clone().map(|e| normalize_etag(&e));
                let prev_cid = obj
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get(META_PREV_CID_KEY))
                    .cloned();
                match obj.body.collect().await {
                    Ok(b) => return Ok((b.into_bytes().to_vec(), et, prev_cid)),
                    Err(e) => {
                        if attempt + 1 >= OP_MAX_RETRIES {
                            return Err(anyhow!("GET body read failed for {key}: {e:?}"));
                        }
                    }
                }
            }
            Err(e) => {
                if let SdkError::ServiceError(se) = &e {
                    if se.raw().status().as_u16() == 404 {
                        return Err(anyhow!("GET 404 for {key}"));
                    }
                }
                if !is_retryable_sdk_error(&e) || attempt + 1 >= OP_MAX_RETRIES {
                    return Err(anyhow!("GET failed for {key}: {e:?}"));
                }
            }
        }
        backoff_attempt(attempt).await;
        attempt += 1;
    }
}

async fn remote_equals_local(
    client: &Client,
    bucket: &str,
    key: &str,
    local_bytes: &[u8],
) -> Result<(bool, Option<String>)> {
    let (remote_bytes, remote_etag, _remote_prev_cid) =
        get_object_bytes_with_retries(client, bucket, key).await?;
    let local_cid = hex::encode(Sha256::digest(local_bytes));
    let remote_cid = hex::encode(Sha256::digest(&remote_bytes));
    Ok((local_cid == remote_cid, remote_etag))
}

/* ============================ Local path utils ============================== */

fn key_to_local_path(local_root: &str, key: &str) -> PathBuf {
    let mut pb = PathBuf::from(local_root);
    for seg in key.split('/') {
        if !seg.is_empty() {
            pb.push(seg);
        }
    }
    pb
}

async fn ensure_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio_fs::create_dir_all(parent).await?;
    }
    Ok(())
}

async fn safe_rename(src: &Path, dst: &Path) -> Result<()> {
    if let Err(_e) = tokio_fs::rename(src, dst).await {
        ensure_parent(dst).await?;
        let data = tokio_fs::read(src).await?;
        tokio_fs::write(dst, &data).await?;
        tokio_fs::remove_file(src).await.map_err(|e2| {
            anyhow!(
                "rename fallback remove failed after copy (src={:?}, dst={:?}): {e2:?}",
                src,
                dst
            )
        })?;
        if let Err(e3) = tokio_fs::metadata(dst).await {
            return Err(anyhow!(
                "rename fallback verification failed (dst missing): {e3:?}"
            ));
        }
    }
    Ok(())
}

/* ============================ Conflict helpers ============================= */

fn join_rel(left: &str, right: &str) -> String {
    if left.is_empty() {
        right.to_string()
    } else {
        format!(
            "{}/{}",
            left.trim_end_matches('/'),
            right.trim_start_matches('/')
        )
    }
}

fn split_dir_stem_ext(original: &str) -> (String, String, String) {
    let p = Path::new(original);
    let parent: String = p
        .parent()
        .map(|pp| pp.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let stem: String = p
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let ext: String = p
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    (parent, stem, ext)
}

/// <name[.ext]>_conflict_<remoteetag16|noetag>_<localcid16|nocid>_<client8>
fn make_conflict_name_deterministic(
    original: &str,
    local_cid: &str,
    remote_etag: &str,
    client_tag: &str,
) -> String {
    use std::fmt::Write;
    let (parent, stem, ext) = split_dir_stem_ext(original);

    let ne = normalize_etag(remote_etag);
    let etag_tag: String = if ne.is_empty() {
        "noetag".into()
    } else {
        ne.chars().take(16).collect()
    };
    let lc_tag: String = if local_cid.is_empty() {
        "nocid".into()
    } else {
        local_cid.chars().take(16).collect()
    };
    let suffix = format!("{etag_tag}_{lc_tag}_{client_tag}");

    let mut base = String::new();
    if ext.is_empty() {
        let _ = write!(&mut base, "{stem}_conflict_{suffix}");
    } else {
        let _ = write!(&mut base, "{stem}_conflict_{suffix}.{ext}");
    }

    if parent.is_empty() {
        base
    } else {
        join_rel(&parent, &base)
    }
}

async fn choose_available_conflict(local_root: &str, desired: &str) -> Result<(String, PathBuf)> {
    let mut candidate_rel = desired.to_string();
    let bump_once = |rel: &str, idx: u32| -> String { format!("{rel} ({idx})") };
    let mut idx: u32 = 2;
    loop {
        let full = key_to_local_path(local_root, &candidate_rel);
        if tokio_fs::metadata(&full).await.is_err() {
            return Ok((candidate_rel.clone(), full));
        }
        candidate_rel = bump_once(&candidate_rel, idx);
        idx += 1;
    }
}

#[allow(dead_code)]
fn bump_rel_candidate(rel: &str, idx: u32) -> String {
    let p = Path::new(rel);
    let parent = p.parent().map(|pp| pp.to_path_buf()).unwrap_or_default();
    let file_os = p.file_name().unwrap_or_default();
    let stem = Path::new(file_os)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let ext = Path::new(file_os)
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();

    let bumped = if ext.is_empty() {
        format!("{stem} ({idx})")
    } else {
        format!("{stem} ({idx}).{ext}")
    };
    let mut out = parent;
    out.push(bumped);
    out.to_string_lossy().replace('\\', "/")
}

/* --------- Robust conflict publish: retry + bump remote key on 412 ---------- */

async fn publish_conflict_object_with_bumps(
    client: &Client,
    bucket: &str,
    local_bytes: &[u8],
    desired_key: &str,
    is_public: bool,
) -> (Option<String>, String) {
    let mut used_key = desired_key.to_string();
    let mut bump_idx: u32 = 2;
    let mut attempt = 0usize;
    println!("[Sync] trying to upload conflict object with bumps: {}", used_key);
    loop {
        let mut req = client
            .put_object()
            .bucket(bucket)
            .key(&used_key)
            .if_none_match("*")
            .body(ByteStream::from(local_bytes.to_vec()));

        if is_public {
            req = req.acl(ObjectCannedAcl::PublicRead);
        }

        let res = req.send().await;

        match res {
            Ok(out) => return (out.e_tag.map(|e| normalize_etag(&e)), used_key),
            Err(SdkError::ServiceError(ref se)) if se.raw().status().as_u16() == 412 => {
                used_key = format!("{desired_key} ({bump_idx})");
                bump_idx += 1;
                continue;
            }
            Err(e) if is_retryable_sdk_error(&e) && attempt + 1 < OP_MAX_RETRIES => {
                backoff_attempt(attempt).await;
                attempt += 1;
                continue;
            }
            Err(_) => {
                backoff_attempt(attempt).await;
                attempt += 1;
                continue;
            }
        }
    }
}

/* ============================ CAS patching ================================= */

#[derive(Debug, Clone)]
enum ManifestPatch {
    BumpDeletion {
        path: String,
        to: u32,
    },
    BumpResurrection {
        path: String,
        to: u32,
    },
    UpdateEtag {
        path: String,
        etag: String,
    },
    SetRename {
        path: String,
        renamed_to: Option<String>,
    },
    ClearRename {
        path: String,
    },
}

fn apply_patches(manifest: &mut Manifest, patches: &[ManifestPatch]) -> bool {
    let mut changed = false;
    for p in patches {
        match p {
            ManifestPatch::BumpDeletion { path, to } => {
                let e = manifest.entries.entry(path.clone()).or_insert(FileMeta {
                    path: path.clone(),
                    etag: String::new(),
                    cid: String::new(),
                    deletion_count: 0,
                    resurrection_count: 0,
                    renamed_to: None,
                });
                if e.deletion_count < *to {
                    e.deletion_count = *to;
                    changed = true;
                }
            }
            ManifestPatch::BumpResurrection { path, to } => {
                let e = manifest.entries.entry(path.clone()).or_insert(FileMeta {
                    path: path.clone(),
                    etag: String::new(),
                    cid: String::new(),
                    deletion_count: 0,
                    resurrection_count: 0,
                    renamed_to: None,
                });
                if e.resurrection_count < *to {
                    e.resurrection_count = *to;
                    changed = true;
                }
            }
            ManifestPatch::UpdateEtag { path, etag } => {
                let e = manifest.entries.entry(path.clone()).or_insert(FileMeta {
                    path: path.clone(),
                    etag: String::new(),
                    cid: String::new(),
                    deletion_count: 0,
                    resurrection_count: 0,
                    renamed_to: None,
                });
                let ne = normalize_etag(etag);
                if e.etag != ne {
                    e.etag = ne;
                    changed = true;
                }
            }
            ManifestPatch::SetRename { path, renamed_to } => {
                let e = manifest.entries.entry(path.clone()).or_insert(FileMeta {
                    path: path.clone(),
                    etag: String::new(),
                    cid: String::new(),
                    deletion_count: 0,
                    resurrection_count: 0,
                    renamed_to: None,
                });
                if &e.renamed_to != renamed_to {
                    e.renamed_to = renamed_to.clone();
                    changed = true;
                }
            }
            ManifestPatch::ClearRename { path } => {
                let e = manifest.entries.entry(path.clone()).or_insert(FileMeta {
                    path: path.clone(),
                    etag: String::new(),
                    cid: String::new(),
                    deletion_count: 0,
                    resurrection_count: 0,
                    renamed_to: None,
                });
                if e.renamed_to.is_some() {
                    e.renamed_to = None;
                    changed = true;
                }
            }
        }
    }
    changed
}

async fn apply_manifest_patches_cas(
    client: &Client,
    bucket: &str,
    mut manifest: Manifest,
    mut manifest_etag: Option<String>,
    patches: &[ManifestPatch],
    max_retries: usize,
) -> Result<(Manifest, Option<String>)> {
    let mut tries = 0usize;
    loop {
        let mut patched = manifest.clone();
        let changed = apply_patches(&mut patched, patches);

        if !changed {
            return Ok((manifest, manifest_etag));
        }

        let (saved, new_etag) =
            save_manifest_cas(client, bucket, &patched, manifest_etag.as_deref()).await?;
        if saved {
            manifest_etag = new_etag;
            return Ok((patched, manifest_etag));
        } else {
            tries += 1;
            if tries > max_retries {
                return Err(anyhow!(
                    "CAS: manifest save conflicted too many times ({max_retries})"
                ));
            }
            small_jitter_backoff().await;
            let (remote_manifest, remote_etag) = load_manifest(client, bucket).await?;
            manifest = remote_manifest;
            manifest_etag = remote_etag;
        }
    }
}

/* ============================ Prunefile I/O ================================= */

async fn load_pruned_remote(
    client: &Client,
    bucket: &str,
    prunefile_id: &str,
) -> Result<(PrunedMap, Option<String>)> {
    let key = pruned_key_for(prunefile_id);
    match client.get_object().bucket(bucket).key(&key).send().await {
        Ok(obj) => {
            let etag = obj.e_tag.map(|e| normalize_etag(&e));
            let bytes = obj.body.collect().await?.to_vec();
            let map: PrunedMap = serde_json::from_slice(&bytes)?;
            Ok((map, etag))
        }
        Err(SdkError::ServiceError(ref se)) => {
            let code = se.raw().status().as_u16();
            if code == 403 {
                return Ok((PrunedMap::default(), None));
            }
            match se.err() {
                GetObjectError::NoSuchKey(_) => Ok((PrunedMap::default(), None)),
                other => Err(anyhow!("load_pruned_remote failed: {other:?}"))?,
            }
        }
        Err(e) => Err(anyhow!("load_pruned_remote failed: {e:?}"))?,
    }
}

async fn save_pruned_remote_cas(
    client: &Client,
    bucket: &str,
    prunefile_id: &str,
    map: &PrunedMap,
    previous_etag: Option<&str>,
) -> Result<(bool, Option<String>)> {
    println!("[Sync] trying to upload prunefile to S3");
    let key = pruned_key_for(prunefile_id);
    let body = serde_json::to_vec_pretty(map)?;
    let mut req = client
        .put_object()
        .bucket(bucket)
        .key(&key)
        .body(ByteStream::from(body));
    req = if let Some(etag) = previous_etag {
        req.if_match(etag)
    } else {
        req.if_none_match("*")
    };
    match req.send().await {
        Ok(out) => Ok((true, out.e_tag.map(|e| normalize_etag(&e)))),
        Err(SdkError::ServiceError(ref se)) if se.raw().status().as_u16() == 412 => {
            Ok((false, None))
        }
        Err(e) => Err(anyhow!("save_pruned_remote_cas failed: {e:?}")),
    }
}

/* ============================ Ops ========================================== */

#[derive(Debug, Clone)]
enum Op {
    Upload { path: String },
    DeleteRemote { path: String },
    Download { path: String },
    DeleteLocal { path: String },
    RenameLocal { from: String, to: String },
}

/* ======================== Execution helpers (prune) ========================= */

fn set_prune_present(pe: &mut PruneEntry, cid: Option<String>, adopted_etag: Option<String>) {
    pe.present = true;
    pe.locally_deleted = false;
    if let Some(c) = cid {
        if !c.is_empty() {
            pe.cid = c;
        }
    }
    if adopted_etag.is_some() {
        pe.adopted_remote_etag = adopted_etag;
    }
}

fn set_prune_absent(pe: &mut PruneEntry) {
    pe.present = false;
}

/* ======================== Conflict flow (policy-aware) ====================== */

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum ConflictStrategy {
    RenameLocalAndAdoptRemote,
    #[allow(dead_code)]
    RenameLocalOnly,
}

async fn execute_conflict_flow(
    client: &Client,
    bucket: &str,
    local_root: &str,
    path: &str,
    local_cid: &str,
    client_tag8: &str,
    remote_etag_hint: Option<String>,
    prune: &mut PrunedMap,
    strategy: ConflictStrategy,
    is_public: bool,
) -> Result<()> {
    println!("[Sync] trying to execute conflict flow");
    match strategy {
        ConflictStrategy::RenameLocalOnly => {
            let conflict_name_base = make_conflict_name_deterministic(
                path,
                local_cid,
                &remote_etag_hint.clone().unwrap_or_default(),
                client_tag8,
            );
            let (conflict_rel, conflict_full) =
                choose_available_conflict(local_root, &conflict_name_base).await?;
            let full_original = key_to_local_path(local_root, path);
            ensure_parent(&conflict_full).await?;
            safe_rename(&full_original, &conflict_full).await?;

            if let Ok(conflict_bytes) = tokio_fs::read(&conflict_full).await {
                let conflict_cid = hex::encode(Sha256::digest(&conflict_bytes));
                let (uploaded_etag, used_key) = publish_conflict_object_with_bumps(
                    client,
                    bucket,
                    &conflict_bytes,
                    &conflict_rel,
                    is_public,
                )
                .await;

                if used_key != conflict_rel {
                    let new_full = key_to_local_path(local_root, &used_key);
                    if let Err(e) = ensure_parent(&new_full).await {
                        eprintln!(
                            "[Sync] ensure parent failed for retagged conflict {:?}: {e:?}",
                            used_key
                        );
                    } else if let Err(e) = safe_rename(&conflict_full, &new_full).await {
                        eprintln!(
                            "[Sync] rename to retagged conflict {:?} failed: {e:?}",
                            used_key
                        );
                    }
                }

                prune.insert(
                    used_key.clone(),
                    PruneEntry {
                        present: uploaded_etag.is_some(),
                        cid: conflict_cid,
                        deletion_count: 0,
                        resurrection_count: 0,
                        adopted_remote_etag: uploaded_etag,
                        locally_deleted: false,
                        file_deletion_policy: None,
                        last_adopted_cid: String::new(),
                    },
                );

                let pe_old = prune.entry(path.to_string()).or_default();
                set_prune_absent(pe_old);
            }
            Ok(())
        }

        ConflictStrategy::RenameLocalAndAdoptRemote => {
            let conflict_name_base = make_conflict_name_deterministic(
                path,
                local_cid,
                &remote_etag_hint.clone().unwrap_or_default(),
                client_tag8,
            );
            let (conflict_rel, conflict_full) =
                choose_available_conflict(local_root, &conflict_name_base).await?;
            let full_original = key_to_local_path(local_root, path);
            ensure_parent(&conflict_full).await?;
            safe_rename(&full_original, &conflict_full).await?;

            let conflict_bytes = tokio_fs::read(&conflict_full).await?;
            let conflict_cid = hex::encode(Sha256::digest(&conflict_bytes));
            let (uploaded_etag, used_key) =
                publish_conflict_object_with_bumps(client, bucket, &conflict_bytes, &conflict_rel, is_public)
                    .await;

            if used_key != conflict_rel {
                let new_full = key_to_local_path(local_root, &used_key);
                if let Err(e) = ensure_parent(&new_full).await {
                    eprintln!(
                        "[Sync] ensure parent failed for retagged conflict {:?}: {e:?}",
                        used_key
                    );
                } else if let Err(e) = safe_rename(&conflict_full, &new_full).await {
                    eprintln!(
                        "[Sync] rename to retagged conflict {:?} failed: {e:?}",
                        used_key
                    );
                }
            }

            prune.insert(
                used_key.clone(),
                PruneEntry {
                    present: uploaded_etag.is_some(),
                    cid: conflict_cid,
                    deletion_count: 0,
                    resurrection_count: 0,
                    adopted_remote_etag: uploaded_etag,
                    locally_deleted: false,
                    file_deletion_policy: None,
                    last_adopted_cid: String::new(),
                },
            );

            if let Ok((body, remote_etag, _remote_prev_cid)) =
                get_object_bytes_with_retries(client, bucket, path).await
            {
                let full = key_to_local_path(local_root, path);
                ensure_parent(&full).await?;
                tokio_fs::write(&full, &body).await?;
                let new_cid = hex::encode(Sha256::digest(&body));
                prune
                    .entry(path.to_string())
                    .and_modify(|pe| {
                        set_prune_present(pe, Some(new_cid.clone()), remote_etag.clone());
                        pe.last_adopted_cid = new_cid.clone();
                    })
                    .or_insert(PruneEntry {
                        present: true,
                        cid: new_cid.clone(),
                        deletion_count: 0,
                        resurrection_count: 0,
                        adopted_remote_etag: remote_etag,
                        locally_deleted: false,
                        file_deletion_policy: None,
                        last_adopted_cid: new_cid,
                    });
            }
            Ok(())
        }
    }
}

/* ============================ Remote↔Manifest =============================== */

fn compute_manifest_patches_from_remote(
    manifest: &Manifest,
    remote: &HashMap<String, FileMeta>,
    confirmed_local_renames: &[(String, String)],
    uploaded_new_etags: &HashMap<String, String>,
) -> Vec<ManifestPatch> {
    let mut patches = Vec::new();

    // Update etags & resurrections for remote-present entries.
    for (rk, rm) in remote {
        if !rm.etag.is_empty() {
            patches.push(ManifestPatch::UpdateEtag {
                path: rk.clone(),
                etag: rm.etag.clone(),
            });
        }
        if let Some(m) = manifest.entries.get(rk) {
            if m.deletion_count > m.resurrection_count {
                patches.push(ManifestPatch::BumpResurrection {
                    path: rk.clone(),
                    to: m.deletion_count,
                });
            }
        }
    }

    // Clear rename markers once both ends have caught up.
    for (mk, m) in &manifest.entries {
        if m.renamed_to.is_some() && remote.contains_key(mk) {
            patches.push(ManifestPatch::ClearRename { path: mk.clone() });
        }
    }

    // Record explicit local renames (which were executed as MOVES on remote).
    for (old, new) in confirmed_local_renames {
        if !remote.contains_key(old) {
            let new_del_to = manifest
                .entries
                .get(old)
                .map(|m| m.deletion_count.max(m.resurrection_count + 1))
                .unwrap_or(1);
            patches.push(ManifestPatch::BumpDeletion {
                path: old.clone(),
                to: new_del_to,
            });
            patches.push(ManifestPatch::SetRename {
                path: old.clone(),
                renamed_to: Some(new.clone()),
            });
            patches.push(ManifestPatch::SetRename {
                path: new.clone(),
                renamed_to: None,
            });
            if let Some(et) = uploaded_new_etags.get(new) {
                patches.push(ManifestPatch::UpdateEtag {
                    path: new.clone(),
                    etag: et.clone(),
                });
            }
        }
    }

    // Rename inference based on matching etags.
    let mut remote_by_etag: HashMap<String, Vec<String>> = HashMap::new();
    for (rk, rm) in remote {
        if !rm.etag.is_empty() {
            remote_by_etag
                .entry(rm.etag.clone())
                .or_default()
                .push(rk.clone());
        }
    }
    for (mk, m) in &manifest.entries {
        if remote.contains_key(mk) {
            continue;
        }
        if !m.etag.is_empty() {
            if let Some(cands) = remote_by_etag.get(&m.etag) {
                if cands.len() == 1 {
                    let new_key = &cands[0];
                    patches.push(ManifestPatch::SetRename {
                        path: mk.clone(),
                        renamed_to: Some(new_key.clone()),
                    });
                    patches.push(ManifestPatch::SetRename {
                        path: new_key.clone(),
                        renamed_to: None,
                    });
                    let new_del_to = m.deletion_count.max(m.resurrection_count + 1);
                    patches.push(ManifestPatch::BumpDeletion {
                        path: mk.clone(),
                        to: new_del_to,
                    });
                    patches.push(ManifestPatch::UpdateEtag {
                        path: new_key.clone(),
                        etag: m.etag.clone(),
                    });
                }
            }
        }
    }

    patches
}

/* ============================= Download gating ============================== */

#[inline]
fn should_download(
    policy: DeletePolicy,
    key: &str,
    local_has: bool,
    prune: &PrunedMap,
    remote_etag: &str,
    manifest: Option<&Manifest>,
) -> bool {
    match policy {
        DeletePolicy::UploadOnly => {
            if local_has {
                let adopted = prune
                    .get(key)
                    .and_then(|p| p.adopted_remote_etag.clone())
                    .unwrap_or_default();
                adopted != remote_etag
            } else {
                false
            }
        }
        DeletePolicy::LocalOnlyDeletes => {
            if local_has {
                let adopted = prune
                    .get(key)
                    .and_then(|p| p.adopted_remote_etag.clone())
                    .unwrap_or_default();
                adopted != remote_etag
            } else {
                let (explicit_local_tomb, counter_tomb) = match prune.get(key) {
                    Some(pe) => (
                        pe.locally_deleted,
                        pe.deletion_count > pe.resurrection_count,
                    ),
                    None => (false, false),
                };
                if explicit_local_tomb {
                    false
                } else if counter_tomb {
                    if let Some(mf) = manifest {
                        if let Some(m) = mf.entries.get(key) {
                            !is_deleted(m.deletion_count, m.resurrection_count)
                        } else {
                            true
                        }
                    } else {
                        true
                    }
                } else {
                    true
                }
            }
        }
        DeletePolicy::MirrorLocalDeletes | DeletePolicy::RestoreFromRemote => {
            let adopted = prune
                .get(key)
                .and_then(|p| p.adopted_remote_etag.clone())
                .unwrap_or_default();
            !local_has || adopted != remote_etag
        }
    }
}

/* ================================ sync_once_cas ============================= */

pub async fn sync_once_cas(
    client: &Client,
    bucket: &str,
    local_root: &str,
    delete_policy: DeletePolicy,
    max_retries: usize,
    prunefile_id: &str,
    is_public: bool,
) -> Result<()> {

    let client_tag8 = client_tag8_from(prunefile_id);

    /* ---- Phase 0: Snapshot ---- */
    let (mut prune, mut prune_etag) = load_pruned_remote(client, bucket, prunefile_id).await?;
    let mut prune_origin = prune.clone();
    let (mut manifest, mut manifest_etag) = load_manifest(client, bucket).await?;
    let local = scan_local(local_root).await?;
    let remote0 = list_remote(client, bucket).await?;

    // Diagnostic logging to detect prune state issues
    println!("[Sync] Phase 0 snapshot complete:");
    println!("  - Prune state entries: {}", prune.len());
    println!("  - Local files scanned: {}", local.len());
    println!("  - Remote files listed: {}", remote0.len());
    println!("  - Manifest entries: {}", manifest.entries.len());
    println!("  - Prunefile ID: {}", prunefile_id);
    if prune.is_empty() && !local.is_empty() {
        eprintln!("[Sync] WARNING: Prune state is EMPTY but local has {} files - all will be treated as NEW!", local.len());
    }

    /* ---- Phase 3 Preamble: REMOTE -> LOCAL (diff vs remote) --------------------------- */

    let mut ops_adopt: Vec<Op> = Vec::new();

    /* ---- Phase 1: LOCAL → REMOTE (diff vs prune) --------------------------- */

    let mut local_by_cid: HashMap<String, Vec<String>> = HashMap::new();
    for (lk, lm) in &local {
        if !lm.cid.is_empty() {
            local_by_cid
                .entry(lm.cid.clone())
                .or_default()
                .push(lk.clone());
        }
    }

    let mut ops_l2r: Vec<Op> = Vec::new();
    let mut scheduled_uploads: HashSet<String> = HashSet::new();
    let mut scheduled_remote_deletes: HashSet<String> = HashSet::new();

    let mut confirmed_local_renames: Vec<(String, String)> = Vec::new();
    let mut uploaded_new_etags: HashMap<String, String> = HashMap::new();

    fn schedule_upload(ops: &mut Vec<Op>, scheduled: &mut HashSet<String>, path: &str) {
        println!("[Sync] trying to scheduling upload for {}", path);
        if is_ignored_key(path) {
            return;
        }
        if scheduled.insert(path.to_string()) {
            ops.push(Op::Upload {
                path: path.to_string(),
            });
        }
    }
    fn schedule_remote_delete(ops: &mut Vec<Op>, scheduled: &mut HashSet<String>, path: &str) {
        if is_ignored_key(path) {
            return;
        }
        if scheduled.insert(path.to_string()) {
            ops.push(Op::DeleteRemote {
                path: path.to_string(),
            });
        }
    }

    for (lk, lm) in &local {
        if is_ignored_key(lk) {
            continue;
        }
        match prune.get(lk) {
            None => {
                println!("[Sync] Scheduling upload for '{}': not in prune state", lk);
                schedule_upload(&mut ops_l2r, &mut scheduled_uploads, lk);
            }
            Some(pe) => {
                if !pe.present {
                    println!("[Sync] Scheduling upload for '{}': marked as not present in prune", lk);
                    schedule_upload(&mut ops_l2r, &mut scheduled_uploads, lk);
                } else if (!pe.cid.is_empty() && pe.cid != lm.cid)
                    || (pe.cid.is_empty() && !lm.cid.is_empty())
                {
                    println!(
                        "[Sync] Scheduling upload for '{}': CID mismatch (prune: '{}', local: '{}')",
                        lk,
                        &pe.cid.chars().take(16).collect::<String>(),
                        &lm.cid.chars().take(16).collect::<String>()
                    );
                    schedule_upload(&mut ops_l2r, &mut scheduled_uploads, lk);
                } else {
                    // File is already synced - CID matches and present=true
                    // This log confirms we're NOT re-uploading unchanged files
                    println!("[Sync] Skipping '{}': already synced (CID matches)", lk);
                }
            }
        }
    }

    // Local deletes / EXACT-ONE rename detection
    let prune_snapshot: Vec<(String, PruneEntry)> =
        prune.iter().map(|(k, v)| (k.clone(), v.clone())).collect();

    let mut claimed_new_paths: HashSet<String> = HashSet::new();
    let mut planned_local_renames_old_to_new: HashMap<String, String> = HashMap::new();
    let mut planned_local_renames_new_to_old: HashMap<String, String> = HashMap::new();

    for (old_path, pe) in prune_snapshot {
        if is_ignored_key(&old_path) || !pe.present {
            continue;
        }
        if local.contains_key(&old_path) {
            continue;
        }

        let mut rename_target: Option<String> = None;
        if !pe.cid.is_empty() {
            if let Some(cands) = local_by_cid.get(&pe.cid) {
                let fresh_new: Vec<String> = cands
                    .iter()
                    .filter(|cand| !prune.contains_key(*cand))
                    .cloned()
                    .collect();
                if fresh_new.len() == 1 {
                    rename_target = Some(fresh_new[0].clone());
                }
            }
        }

        if let Some(new_path) = rename_target {
            if claimed_new_paths.contains(&new_path) {
                continue;
            }
            schedule_upload(&mut ops_l2r, &mut scheduled_uploads, &new_path);

            planned_local_renames_old_to_new.insert(old_path.clone(), new_path.clone());
            planned_local_renames_new_to_old.insert(new_path.clone(), old_path.clone());
            claimed_new_paths.insert(new_path.clone());

            // treat renames as MOVES in all policies
            schedule_remote_delete(&mut ops_l2r, &mut scheduled_remote_deletes, &old_path);

            let pe_old = prune.entry(old_path.clone()).or_default();
            set_prune_absent(pe_old);
            let pe_new = prune.entry(new_path.clone()).or_default();
            pe_new.locally_deleted = false;
        } else {
            if matches!(delete_policy, DeletePolicy::MirrorLocalDeletes) {
                schedule_remote_delete(&mut ops_l2r, &mut scheduled_remote_deletes, &old_path);
            } else {
                let pe_local = prune.entry(old_path.clone()).or_default();
                set_prune_absent(pe_local);
                pe_local.locally_deleted = true;
                pe_local.deletion_count = pe_local.deletion_count.saturating_add(1);
            }
        }
    }

    // Early-exit optimization: skip sync if no operations needed
    // Check this BEFORE executing ops to avoid unnecessary S3 API calls
    let ops_l2r_count = ops_l2r.len();
    println!("[Sync] Phase 1 operations queued: {} uploads/deletes", ops_l2r_count);
    
    // === Execute Phase 1 ops ===
    for op in ops_l2r {
        match op {
            Op::Upload { path } => {
                let full = key_to_local_path(local_root, &path);
                let bytes = match tokio_fs::read(&full).await {
                    Ok(b) => b,
                    Err(e) => {
                        eprintln!("[Sync] upload read failed for {path}: {e:?}");
                        continue;
                    }
                };
                let local_cid = hex::encode(Sha256::digest(&bytes));

                // Decide CAS mode strictly from prune:
                let (use_if_none_match, expected_if_match) = match prune.get(&path) {
                    None => (true, None),
                    Some(pe) if !pe.present => (true, None),
                    Some(pe) => {
                        let pe_etag = pe.adopted_remote_etag.clone();
                        if pe_etag.is_some() {
                            (false, pe_etag)
                        } else {
                            // last resort for modified-but-unknown: use remote0 only here (not for new)
                            let r0 = remote0.get(&path).and_then(|r| {
                                let e = r.etag.clone();
                                if e.is_empty() { None } else { Some(e) }
                            });
                            if r0.is_some() {
                                (false, r0)
                            } else {
                                // still unknown: force create-only; server will 412 if exists -> conflict flow
                                (true, None)
                            }
                        }
                    }
                };

                // prev_cid for S3 metadata: only meaningful when we are doing an update
                // (if_match). We approximate "previous remote content" as the last adopted
                // content id on this client at the start of the sync (or its last known cid).
                let prev_cid_for_meta: Option<String> = if use_if_none_match {
                    None
                } else {
                    let base = prune_origin.get(&path).and_then(|pe0| {
                        if !pe0.last_adopted_cid.is_empty() {
                            Some(pe0.last_adopted_cid.clone())
                        } else if !pe0.cid.is_empty() {
                            Some(pe0.cid.clone())
                        } else {
                            None
                        }
                    });
                    base
                };

                let r0 = remote0.get(&path).and_then(|r| {
                    let e = r.etag.clone();
                    if e.is_empty() { None } else { Some(e) }
                });

                let pe = prune.entry(path.clone()).or_default();
                let pe_etag = pe.adopted_remote_etag.clone();

                if (r0.is_some() && pe_etag.is_none())
                    || (r0.is_some() && pe_etag.is_some() && r0 != pe_etag)
                {
                    // preemptive conflict resolution
                    // skip upload and handle conflict in download
                    ops_adopt.push(Op::Download { path: path.clone() });
                    continue;
                }

                let mut attempt = 0usize;
                let put_outcome: Option<String> = loop {
                    let mut req = client
                        .put_object()
                        .bucket(bucket)
                        .key(&path)
                        .body(ByteStream::from(bytes.clone()));

                    if is_public {
                        req = req.acl(ObjectCannedAcl::PublicRead);
                    }

                    if let Some(ref prev) = prev_cid_for_meta {
                        if !prev.is_empty() {
                            req = req.metadata(META_PREV_CID_KEY, prev.clone());
                        }
                    }

                    req = if use_if_none_match {
                        req.if_none_match("*")
                    } else if let Some(ref et) = expected_if_match {
                        req.if_match(et.clone())
                    } else {
                        req
                    };

                    let put_res = req.send().await;

                    match put_res {
                        Ok(out) => {
                            match remote_equals_local(client, bucket, &path, &bytes).await {
                                Ok((equal, verified_etag)) => {
                                    let final_et = verified_etag
                                        .or_else(|| out.e_tag.map(|e| normalize_etag(&e)))
                                        .unwrap_or_default();
                                    if equal {
                                        break Some(final_et);
                                    } else {
                                        if let Err(e) = execute_conflict_flow(
                                            client,
                                            bucket,
                                            local_root,
                                            &path,
                                            &local_cid,
                                            &client_tag8,
                                            Some(final_et.clone()),
                                            &mut prune,
                                            ConflictStrategy::RenameLocalAndAdoptRemote,
                                            is_public,
                                        )
                                        .await
                                        {
                                            eprintln!(
                                                "[Sync] conflict flow after PUT failed for {path}: {e:?}"
                                            );
                                        }
                                        break None;
                                    }
                                }
                                Err(_) => {
                                    // Verification failed; accept success tag (likely no conflict)
                                    break None;
                                }
                            }
                        }
                        Err(SdkError::ServiceError(ref se))
                            if se.raw().status().as_u16() == 412 =>
                        {
                            // CAS miss => conflict depending on policy (handled as before)
                            if matches!(delete_policy, DeletePolicy::UploadOnly) {
                                if let Err(e) = execute_conflict_flow(
                                    client,
                                    bucket,
                                    local_root,
                                    &path,
                                    &local_cid,
                                    &client_tag8,
                                    None,
                                    &mut prune,
                                    ConflictStrategy::RenameLocalAndAdoptRemote,
                                    is_public,
                                )
                                .await
                                {
                                    eprintln!(
                                        "[Sync] conflict flow (UploadOnly) failed for {path}: {e:?}"
                                    );
                                }
                                break None;
                            } else {
                                match remote_equals_local(client, bucket, &path, &bytes).await {
                                    Ok((equal, remote_et)) => {
                                        if equal {
                                            break Some(remote_et.unwrap_or_default());
                                        } else {
                                            if let Err(e) = execute_conflict_flow(
                                                client,
                                                bucket,
                                                local_root,
                                                &path,
                                                &local_cid,
                                                &client_tag8,
                                                remote_et.clone(),
                                                &mut prune,
                                                ConflictStrategy::RenameLocalAndAdoptRemote,
                                                is_public,
                                            )
                                            .await
                                            {
                                                eprintln!(
                                                    "[Sync] conflict flow failed for {path}: {e:?}"
                                                );
                                            }
                                            break None;
                                        }
                                    }
                                    Err(_e) => {
                                        if attempt + 1 < OP_MAX_RETRIES {
                                            backoff_attempt(attempt).await;
                                            attempt += 1;
                                            continue;
                                        } else {
                                            if let Err(e2) = execute_conflict_flow(
                                                client,
                                                bucket,
                                                local_root,
                                                &path,
                                                &local_cid,
                                                &client_tag8,
                                                None,
                                                &mut prune,
                                                ConflictStrategy::RenameLocalAndAdoptRemote,
                                                is_public,
                                            )
                                            .await
                                            {
                                                eprintln!(
                                                    "[Sync] conflict flow (fallback) failed for {path}: {e2:?}"
                                                );
                                            }
                                            break None;
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) if is_retryable_sdk_error(&e) && attempt + 1 < OP_MAX_RETRIES => {
                            backoff_attempt(attempt).await;
                            attempt += 1;
                            continue;
                        }
                        Err(e) => {
                            eprintln!("[Sync] PUT failed for {path}: {e:?}");
                            break None;
                        }
                    }
                };

                if let Some(remote_etag_final) = put_outcome {
                    let pe = prune.entry(path.clone()).or_default();
                    set_prune_present(pe, Some(local_cid.clone()), Some(remote_etag_final.clone()));
                    pe.last_adopted_cid = local_cid.clone();
                    if pe.deletion_count > pe.resurrection_count {
                        pe.resurrection_count = pe.deletion_count;
                    }
                    if let Some(old) = planned_local_renames_new_to_old.get(&path) {
                        let pe_old = prune.entry(old.clone()).or_default();
                        set_prune_absent(pe_old);
                        pe_old.locally_deleted = false;
                    }
                    uploaded_new_etags.insert(path.clone(), remote_etag_final);
                }
            }

            Op::DeleteRemote { path } => {
                let expected = remote0
                    .get(&path)
                    .and_then(|r| {
                        if r.etag.is_empty() {
                            None
                        } else {
                            Some(r.etag.clone())
                        }
                    })
                    .or_else(|| prune.get(&path).and_then(|p| p.adopted_remote_etag.clone()))
                    .or_else(|| {
                        manifest
                            .entries
                            .get(&path)
                            .map(|m| m.etag.clone())
                            .filter(|s| !s.is_empty())
                    });

                let mut attempt = 0usize;
                let mut success = false;
                if let Some(etag) = expected {
                    loop {
                        let res = client
                            .delete_object()
                            .bucket(bucket)
                            .key(&path)
                            .if_match(etag.clone())
                            .send()
                            .await;

                        match res {
                            Ok(_) => {
                                success = true;
                                break;
                            }
                            Err(SdkError::ServiceError(ref se))
                                if se.raw().status().as_u16() == 412 =>
                            {
                                success = false;
                                break;
                            }
                            Err(e)
                                if is_retryable_sdk_error(&e) && attempt + 1 < OP_MAX_RETRIES =>
                            {
                                backoff_attempt(attempt).await;
                                attempt += 1;
                                continue;
                            }
                            Err(_) => {
                                success = false;
                                break;
                            }
                        }
                    }
                } else {
                    eprintln!("[Sync] DeleteRemote skipped (no ETag known) for {path}");
                }

                if success {
                    let pe = prune.entry(path.clone()).or_default();
                    set_prune_absent(pe);
                    pe.deletion_count = pe.deletion_count.saturating_add(1);
                    pe.locally_deleted = false;

                    if let Some(new) = planned_local_renames_old_to_new.get(&path) {
                        confirmed_local_renames.push((path.clone(), new.clone()));
                    }
                }
            }

            _ => {}
        }
    }

    if prune != prune_origin {
        match save_pruned_remote_cas(client, bucket, prunefile_id, &prune, prune_etag.as_deref())
            .await
        {
            Ok((true, new_etag)) => {
                println!("[Sync] Prune state saved successfully (Phase 1)");
                prune_etag = new_etag;
            }
            Ok((false, _)) => {
                eprintln!("[Sync] WARNING: Prune save conflicted (Phase 1) - merging remote state");
                if let Ok((cur, etag2)) = load_pruned_remote(client, bucket, prunefile_id).await {
                    let mut merged = prune.clone();
                    for (k, v) in cur {
                        let me = merged.entry(k).or_default();
                        me.deletion_count = me.deletion_count.max(v.deletion_count);
                        me.resurrection_count = me.resurrection_count.max(v.resurrection_count);
                        me.present = me.present || v.present;
                        me.locally_deleted = me.locally_deleted || v.locally_deleted;
                        if me.adopted_remote_etag.is_none() {
                            me.adopted_remote_etag = v.adopted_remote_etag;
                        }
                        if me.cid.is_empty() && !v.cid.is_empty() {
                            me.cid = v.cid;
                        }
                        if me.last_adopted_cid.is_empty() && !v.last_adopted_cid.is_empty() {
                            me.last_adopted_cid = v.last_adopted_cid;
                        }
                        if me.file_deletion_policy.is_none() && v.file_deletion_policy.is_some() {
                            me.file_deletion_policy = v.file_deletion_policy;
                        }
                    }
                    let _ = save_pruned_remote_cas(
                        client,
                        bucket,
                        prunefile_id,
                        &merged,
                        etag2.as_deref(),
                    )
                    .await;
                    prune = merged;
                    prune_etag = etag2;
                }
            }
            Err(e) => eprintln!("[Sync] warning: save prunefile (phase1) failed: {e:?}"),
        }
    } else {
        println!("[Sync] Prune state unchanged, skipping Phase 1 save");
    }

    /* ---- Phase 2: Remote → Manifest --------------------------------------- */
    let remote = list_remote(client, bucket).await?;
    let confirmed_for_manifest = confirmed_local_renames.clone();
    let manifest_patches = compute_manifest_patches_from_remote(
        &manifest,
        &remote,
        &confirmed_for_manifest,
        &uploaded_new_etags,
    );
    let (m2, et2) = apply_manifest_patches_cas(
        client,
        bucket,
        manifest,
        manifest_etag,
        &manifest_patches,
        max_retries,
    )
    .await?;
    manifest = m2;
    manifest_etag = et2;

    /* ---- Phase 3: Adopt remote → local (per policy) ------------------------ */

    match delete_policy {
        DeletePolicy::UploadOnly => {
            // Renames FIRST
            for (old_path, m) in &manifest.entries {
                if let Some(new_path) = &m.renamed_to {
                    let old_on_remote = remote.contains_key(old_path);
                    let new_on_remote = remote.contains_key(new_path);

                    if !old_on_remote && new_on_remote {
                        let old_exists_locally = prune
                            .get(old_path)
                            .map(|p| p.present)
                            .unwrap_or_else(|| local.contains_key(old_path));

                        if old_exists_locally {
                            ops_adopt.push(Op::RenameLocal {
                                from: old_path.clone(),
                                to: new_path.clone(),
                            });
                        } else if let Some(pe_old) = prune.get(old_path) {
                            let we_had_it_before = !pe_old.cid.is_empty()
                                && (pe_old.resurrection_count > 0 || pe_old.deletion_count > 0);
                            let we_deleted_it_intentionally = pe_old.locally_deleted;
                            if we_had_it_before && !we_deleted_it_intentionally {
                                ops_adopt.push(Op::Download {
                                    path: new_path.clone(),
                                });
                            }
                        }
                    } else if old_on_remote
                        && new_on_remote
                        && m.deletion_count > m.resurrection_count
                    {
                        let old_exists_locally = prune
                            .get(old_path)
                            .map(|p| p.present)
                            .unwrap_or_else(|| local.contains_key(old_path));
                        if old_exists_locally {
                            ops_adopt.push(Op::RenameLocal {
                                from: old_path.clone(),
                                to: new_path.clone(),
                            });
                        }
                    }
                }
            }

            // Download new versions for files we have locally
            for (rk, rmeta) in &remote {
                if is_ignored_key(rk) {
                    continue;
                }
                let handled_as_rename = ops_adopt.iter().any(|op| {
                    matches!(op, Op::Download { path } | Op::RenameLocal { to: path, .. } if path == rk)
                });
                if handled_as_rename {
                    continue;
                }

                let local_exists = prune
                    .get(rk)
                    .map(|p| p.present)
                    .unwrap_or_else(|| local.contains_key(rk));

                if should_download(
                    DeletePolicy::UploadOnly,
                    rk,
                    local_exists,
                    &prune,
                    &rmeta.etag,
                    Some(&manifest),
                ) {
                    ops_adopt.push(Op::Download { path: rk.clone() });
                }
            }

            // Handle global deletions
            for (mk, m) in &manifest.entries {
                if !remote.contains_key(mk) || is_deleted(m.deletion_count, m.resurrection_count) {
                    if m.renamed_to.is_some() {
                        let already_handled = ops_adopt
                            .iter()
                            .any(|op| matches!(op, Op::RenameLocal { from, .. } if from == mk));
                        if already_handled {
                            continue;
                        }
                    }

                    let local_exists = prune
                        .get(mk)
                        .map(|p| p.present)
                        .unwrap_or_else(|| local.contains_key(mk));
                    if local_exists {
                        ops_adopt.push(Op::DeleteLocal { path: mk.clone() });
                    }

                    let pe = prune.entry(mk.clone()).or_default();
                    set_prune_absent(pe);
                    pe.deletion_count = pe.deletion_count.max(m.deletion_count);
                    pe.resurrection_count = pe.resurrection_count.max(m.resurrection_count);
                }
            }
        }
        DeletePolicy::LocalOnlyDeletes => {
            for (rk, rmeta) in &remote {
                if is_ignored_key(rk) {
                    continue;
                }
                if prune.get(rk).map(|p| p.locally_deleted).unwrap_or(false) {
                    continue;
                }
                let local_exists = prune
                    .get(rk)
                    .map(|p| p.present)
                    .unwrap_or_else(|| local.contains_key(rk));

                if should_download(
                    DeletePolicy::LocalOnlyDeletes,
                    rk,
                    local_exists,
                    &prune,
                    &rmeta.etag,
                    Some(&manifest),
                ) {
                    ops_adopt.push(Op::Download { path: rk.clone() });
                }
            }

            for (mk, m) in &manifest.entries {
                if !remote.contains_key(mk) || is_deleted(m.deletion_count, m.resurrection_count) {
                    let local_exists = prune
                        .get(mk)
                        .map(|p| p.present)
                        .unwrap_or_else(|| local.contains_key(mk));
                    if local_exists {
                        ops_adopt.push(Op::DeleteLocal { path: mk.clone() });
                    }
                    let pe = prune.entry(mk.clone()).or_default();
                    set_prune_absent(pe);
                    pe.deletion_count = pe.deletion_count.max(m.deletion_count);
                    pe.resurrection_count = pe.resurrection_count.max(m.resurrection_count);
                }
            }

            for (old, m) in &manifest.entries {
                if let Some(to) = &m.renamed_to {
                    if !remote.contains_key(old) {
                        let old_exists = prune
                            .get(old)
                            .map(|p| p.present)
                            .unwrap_or_else(|| local.contains_key(old));
                        let dest_is_tombstoned =
                            prune.get(to).map(|pe| pe.locally_deleted).unwrap_or(false);
                        if old_exists && !dest_is_tombstoned {
                            ops_adopt.push(Op::RenameLocal {
                                from: old.clone(),
                                to: to.clone(),
                            });
                        }
                    }
                }
            }
        }

        DeletePolicy::MirrorLocalDeletes | DeletePolicy::RestoreFromRemote => {
            for (rk, rmeta) in &remote {
                if is_ignored_key(rk) {
                    continue;
                }
                let local_exists = prune
                    .get(rk)
                    .map(|p| p.present)
                    .unwrap_or_else(|| local.contains_key(rk));
                if should_download(
                    delete_policy,
                    rk,
                    local_exists,
                    &prune,
                    &rmeta.etag,
                    Some(&manifest),
                ) {
                    ops_adopt.push(Op::Download { path: rk.clone() });
                }
            }

            for (mk, m) in &manifest.entries {
                if !remote.contains_key(mk) || is_deleted(m.deletion_count, m.resurrection_count) {
                    let local_exists = prune
                        .get(mk)
                        .map(|p| p.present)
                        .unwrap_or_else(|| local.contains_key(mk));
                    if local_exists {
                        ops_adopt.push(Op::DeleteLocal { path: mk.clone() });
                    }
                    let pe = prune.entry(mk.clone()).or_default();
                    set_prune_absent(pe);
                    pe.locally_deleted = false;
                    pe.deletion_count = pe.deletion_count.max(m.deletion_count);
                    pe.resurrection_count = pe.resurrection_count.max(m.resurrection_count);
                }
            }

            for (old, m) in &manifest.entries {
                if let Some(to) = &m.renamed_to {
                    if !remote.contains_key(old) {
                        let old_exists = prune
                            .get(old)
                            .map(|p| p.present)
                            .unwrap_or_else(|| local.contains_key(old));
                        if old_exists {
                            ops_adopt.push(Op::RenameLocal {
                                from: old.clone(),
                                to: to.clone(),
                            });
                        }
                    }
                }
            }
        }
    }

    // Early-exit if no operations needed (both phases)
    let ops_adopt_count = ops_adopt.len();
    println!("[Sync] Phase 3 operations queued: {} downloads/renames/deletes", ops_adopt_count);
    
    if ops_l2r_count == 0 && ops_adopt_count == 0 {
        println!("[Sync] No changes detected, skipping sync cycle");
        return Ok(());
    }

    // === Execute ADOPT ops ===
    for op in ops_adopt {
        match op {
            Op::Download { path } => {
                // LOD gating (unchanged)
                if matches!(delete_policy, DeletePolicy::LocalOnlyDeletes) {
                    if let Some(pe) = prune.get(&path) {
                        let globally_resurrected = manifest
                            .entries
                            .get(&path)
                            .map(|m| !is_deleted(m.deletion_count, m.resurrection_count))
                            .unwrap_or(true);
                        if pe.locally_deleted {
                            continue;
                        }
                        if (pe.deletion_count > pe.resurrection_count) && !globally_resurrected {
                            continue;
                        }
                    }
                }

                match get_object_bytes_with_retries(client, bucket, &path).await {
                    Ok((body, remote_etag, remote_prev_cid_opt)) => {
                        let remote_cid_now = hex::encode(Sha256::digest(&body));
                        let full = key_to_local_path(local_root, &path);
                        let pe_snap = prune.get(&path).cloned();
                        let local_exists_now = tokio_fs::metadata(&full).await.is_ok();

                        let remote_prev_cid = remote_prev_cid_opt.unwrap_or_default();

                        // Commit helper: also refresh last_adopted_cid here (only in download path).
                        let commit_prune_after_adopt = |pe: &mut PruneEntry| {
                            set_prune_present(
                                pe,
                                Some(remote_cid_now.clone()),
                                remote_etag.clone(),
                            );
                            pe.last_adopted_cid = remote_cid_now.clone();
                            if pe.deletion_count > pe.resurrection_count {
                                pe.resurrection_count = pe.deletion_count;
                            }
                            if let Some(m) = manifest.entries.get(&path) {
                                pe.deletion_count = pe.deletion_count.max(m.deletion_count);
                                pe.resurrection_count =
                                    pe.resurrection_count.max(m.resurrection_count);
                            }
                        };

                        if !local_exists_now {
                            if let Err(e) = ensure_parent(&full).await {
                                eprintln!("[Sync] ensure parent failed for {path}: {e:?}");
                                continue;
                            }
                            if let Err(e) = tokio_fs::write(&full, &body).await {
                                eprintln!("[Sync] write failed for {path}: {e:?}");
                                continue;
                            }
                            let pe = prune.entry(path.clone()).or_default();
                            commit_prune_after_adopt(pe);
                            continue;
                        }

                        match tokio_fs::read(&full).await {
                            Ok(local_bytes) => {
                                let local_cid_now = hex::encode(Sha256::digest(&local_bytes));

                                if local_cid_now == remote_cid_now {
                                    let pe = prune.entry(path.clone()).or_default();
                                    commit_prune_after_adopt(pe);
                                    continue;
                                }

                                // Preferred base: last adopted (downloaded) content.
                                let adopted_base = pe_snap
                                    .as_ref()
                                    .map(|p| p.last_adopted_cid.clone())
                                    .unwrap_or_default();

                                let r0 = remote0.get(&path).and_then(|r| {
                                    let e = r.etag.clone();
                                    if e.is_empty() { None } else { Some(e) }
                                });

                                let pe = prune.entry(path.clone()).or_default();
                                let pe_etag = pe.adopted_remote_etag.clone();

                                let pe_snap_orig = prune_origin.entry(path.clone()).or_default();
                                let pe_o_etag = pe_snap_orig.adopted_remote_etag.clone();

                                let me_last_cid = remote_prev_cid.clone();

                                if !adopted_base.is_empty() {
                                    let local_diverged = local_cid_now != adopted_base;
                                    let remote_diverged = remote_cid_now != adopted_base;

                                    if local_diverged && remote_diverged
                                        || (((((r0.is_some() && pe_etag.is_none())
                                            || (r0.is_some()
                                                && pe_etag.is_some()
                                                && r0 != pe_etag))
                                            && r0 != remote_etag)
                                            || (((remote_etag.is_some() && pe_etag.is_none())
                                                || (remote_etag.is_some()
                                                    && pe_etag.is_some()
                                                    && remote_etag != pe_etag))
                                                && r0 != pe_etag))
                                            // Use previous_cid from S3 metadata instead of manifest.
                                            && me_last_cid != local_cid_now)
                                    {
                                        // TRUE CONFLICT against the last adopted base
                                        let local_cid_for_tag = local_cid_now.clone();

                                        if let Err(e) = execute_conflict_flow(
                                            client,
                                            bucket,
                                            local_root,
                                            &path,
                                            &local_cid_for_tag,
                                            &client_tag8,
                                            remote_etag.clone(),
                                            &mut prune,
                                            ConflictStrategy::RenameLocalAndAdoptRemote,
                                            is_public,
                                        )
                                        .await
                                        {
                                            eprintln!(
                                                "[Sync] adopt conflict flow failed for {path}: {e:?}"
                                            );
                                        }
                                        continue;
                                    } else if !local_diverged && remote_diverged {
                                        // Remote-only change since last adoption → safe overwrite
                                        if let Err(e) = tokio_fs::write(&full, &body).await {
                                            eprintln!(
                                                "[Sync] overwrite write failed for {path}: {e:?}"
                                            );
                                            continue;
                                        }
                                        let pe = prune.entry(path.clone()).or_default();
                                        commit_prune_after_adopt(pe);
                                        continue;
                                    } else {
                                        // Either local-only change (odd to be here) or no content change
                                        // Do not clobber; at most refresh ETag if matching adopted base
                                        let pe = prune.entry(path.clone()).or_default();
                                        if remote_cid_now == adopted_base {
                                            if remote_etag.is_some() {
                                                pe.adopted_remote_etag = remote_etag.clone();
                                            }
                                        }
                                        continue;
                                    }
                                } else {
                                    // No adopted base recorded (first-time adopter on this client)

                                    if local_cid_now != remote_cid_now {
                                        // Conservative conflict: avoid data loss
                                        let local_cid_for_tag = local_cid_now.clone();

                                        if let Err(e) = execute_conflict_flow(
                                            client,
                                            bucket,
                                            local_root,
                                            &path,
                                            &local_cid_for_tag,
                                            &client_tag8,
                                            remote_etag.clone(),
                                            &mut prune,
                                            ConflictStrategy::RenameLocalAndAdoptRemote,
                                            is_public,
                                        )
                                        .await
                                        {
                                            eprintln!(
                                                "[Sync] adopt conflict flow failed for {path}: {e:?}"
                                            );
                                        }
                                        continue;
                                    } else {
                                        // Equal → just adopt and record base
                                        let pe = prune.entry(path.clone()).or_default();
                                        commit_prune_after_adopt(pe);
                                        continue;
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("[Sync] read(local) failed for {path}: {e:?}");
                                // Conservative: do not overwrite unreadable files silently.
                            }
                        }
                    }
                    Err(e) => eprintln!("[Sync] GET failed: {path}: {e:?}"),
                }
            }

            Op::DeleteLocal { path } => {
                let full = key_to_local_path(local_root, &path);
                if let Err(e) = tokio_fs::remove_file(&full).await {
                    eprintln!("[Sync] DeleteLocal failed: {path}: {e:?}");
                } else {
                    let pe = prune.entry(path.clone()).or_default();
                    set_prune_absent(pe);
                    if !matches!(
                        delete_policy,
                        DeletePolicy::UploadOnly | DeletePolicy::LocalOnlyDeletes
                    ) {
                        pe.locally_deleted = false;
                    }
                    if let Some(m) = manifest.entries.get(&path) {
                        pe.deletion_count = pe.deletion_count.max(m.deletion_count);
                        pe.resurrection_count = pe.resurrection_count.max(m.resurrection_count);
                    }
                }
            }

            Op::RenameLocal { from, to } => {
                let src = key_to_local_path(local_root, &from);
                let dst = key_to_local_path(local_root, &to);
                if tokio_fs::metadata(&src).await.is_ok() {
                    if let Err(e) = ensure_parent(&dst).await {
                        eprintln!("[Sync] ensure parent failed for rename {from}->{to}: {e:?}");
                    } else if let Err(e) = safe_rename(&src, &dst).await {
                        eprintln!("[Sync] local rename failed {from}->{to}: {e:?}");
                    } else {
                        let to_cid = if let Ok(bytes) = tokio_fs::read(&dst).await {
                            hex::encode(Sha256::digest(&bytes))
                        } else {
                            String::new()
                        };
                        {
                            let pe_old = prune.entry(from.clone()).or_default();
                            set_prune_absent(pe_old);
                        }
                        {
                            let pe_new = prune.entry(to.clone()).or_default();
                            pe_new.present = true;
                            pe_new.locally_deleted = false;
                            if !to_cid.is_empty() {
                                pe_new.cid = to_cid;
                            }
                            if let Some(m) = manifest.entries.get(&to) {
                                pe_new.deletion_count = pe_new.deletion_count.max(m.deletion_count);
                                pe_new.resurrection_count =
                                    pe_new.resurrection_count.max(m.resurrection_count);
                            }
                        }
                    }
                }
            }

            // allow DeleteRemote to be executed during adopt if queued
            Op::DeleteRemote { path } => {
                if let Some(et) = remote.get(&path).and_then(|r| {
                    if r.etag.is_empty() {
                        None
                    } else {
                        Some(r.etag.clone())
                    }
                }) {
                    let _ = client
                        .delete_object()
                        .bucket(bucket)
                        .key(&path)
                        .if_match(et)
                        .send()
                        .await;
                }
            }

            Op::Upload { .. } => {}
        }
    }

    // Final saves
    let _ =
        save_pruned_remote_cas(client, bucket, prunefile_id, &prune, prune_etag.as_deref()).await;
    let _ = apply_manifest_patches_cas(client, bucket, manifest, manifest_etag, &[], max_retries)
        .await?;

    Ok(())
}

