//! No-mock, two-account end-to-end for shared drives (phase 2, Task 7).
//!
//! Drives the REAL desktop shared-drive code paths against a REAL
//! `hcfs-server` running with `HCFS_FEATURE_SHARED_DRIVES=1`, across TWO
//! bearer identities: an owner mints an invite for their drive, a member
//! accepts it with a sealed grant, syncs the drive locally, files round-trip
//! in BOTH directions, and revocation surfaces on the member while their
//! local files stay intact. The only test doubles are the *inputs* (tempdir
//! roots, seeded SQLite rows) — never the network or the server.
//!
//! # What real layers this drives
//!
//! - **The desktop HTTP layer** (`shared_drives::commands`): `http_create_invite`,
//!   `http_list_memberships`, `http_remove_member` against the live routes,
//!   with per-account bearers the server resolves through its auth-verify
//!   endpoint — exactly the calls `create_drive_invite` /
//!   `list_my_drive_memberships` / `remove_drive_member` make.
//! - **The grant contract** (`shared_drives::grant`): the member seals the
//!   owner's folder-mnemonic entropy with `seal_grant`, the server stores the
//!   blob at accept time, and the desktop's `add_shared_drive` lookup path
//!   (`http_list_memberships` → `open_grant`) recovers the exact entropy.
//! - **The member install seam** (`install_member_drive`): the `sync_paths`
//!   member row + the `enc_mnemonic.json` seal, against a production-shaped
//!   pool and a pinned `$HOME`.
//! - **The identity resolver** (`sync::identity::resolve_drive_identity`):
//!   both drives' engine configs are built from the RESOLVED identity — the
//!   owner row resolves to the own-drive passthrough, the member row to the
//!   owner's wire pair with `shared_drive_member` set (the `build_hcfs_config`
//!   contract, mirrored field-for-field here because that helper is
//!   `pub(crate)`; pinned by `config::tests::build_hcfs_config_*`).
//! - **The real sync engine**: each side runs its own
//!   `hcfs_client::engine::SyncRunner` (the desktop's engine, with a capture
//!   handler in place of the Tauri bridge) and full `trigger_sync` cycles —
//!   upload, remote fetch, download, and the member folder-recovery path
//!   that substitutes [`SHARED_DRIVE_REVOKED_MARKER`].
//!
//! # The two revocation shapes (VERIFIED against the pinned rev)
//!
//! Both live shapes now surface [`SHARED_DRIVE_REVOKED_MARKER`] — hcfs PR
//! #349's **two-stage revocation arbiter** (`check_and_recover_remote_folder`)
//! closed the gap this e2e originally found (raw 403 / suspicious-empty
//! leaking through as generic sync failures):
//!
//! 1. **The owner removes the MEMBER** (the `remove_drive_member` owner
//!    path): the member's `fetch_remote_state` is answered **403 Forbidden**.
//!    With a single membership under that owner, the owner-scoped
//!    `/list_folders/{owner}` gate itself answers the same uniform 403
//!    (stage 1 is forbidden-shaped, so it cannot arbitrate), and **stage 2**
//!    consults `GET /v1/drive-memberships` with the member's own bearer —
//!    a 200 without the `(owner_ss58, folder_hash)` row confirms revocation
//!    and the marker is substituted into the `SyncError` event. A row still
//!    present, or any memberships fetch failure, stays transient with the
//!    ORIGINAL error (fail-closed: a 403 alone never confirms — a
//!    membership-DB outage produces the same 403).
//! 2. **The drive disappears** (owner unregisters/deletes the drive while
//!    the membership row survives): the member's `get_state` succeeds with
//!    ZERO files and the engine's mass-deletion guard aborts the cycle
//!    ("Suspicious empty remote response ..."); that shape is a revocation
//!    candidate, and **stage 1** — the owner-scoped listing, which the
//!    dangling membership row still authorizes — 200s WITHOUT the folder,
//!    confirming the marker. Either way the member's local files are never
//!    touched.
//!
//! The two assertions below are the flipped tripwires: they require the
//! surfaced error to EQUAL the marker, so a future pin bump that regresses
//! either arbiter stage fails them. (Live re-run history: 2026-08-20 at pin
//! `3ff8e9f` — both shapes leaked the raw errors, gap filed; 2026-08-21 at
//! pin `ab4b5cd` — both shapes surface the marker.)
//!
//! # What it does NOT drive (and why that's honest)
//!
//! `initialize_sync_inner` and the revocation *surfacing* (classify →
//! `handle_shared_drive_revoked` → `DriveStatus::Error`) need a Tauri
//! `AppHandle`, so they are pinned hermetically instead
//! (`tests/shared_drive_wiring.rs`, `tests/drive_status.rs`); these tests
//! assert the engine-side boundary those paths key on — the `SyncError`
//! event and its message.
//!
//! # How to run
//!
//! Needs a local hcfs-server AT OR PAST the pinned shared-drives rev with
//! the feature env ON, plus its auth-verify stub mapping two bearers to two
//! ss58s (hcfs ships both: see the `e2e-local` job in hcfs `.github/
//! workflows/ci.yml` and `scripts/e2e-auth-stub.py`). File transfers need a
//! real storage backend (`HCFS_STORAGE_BACKEND=s3` + MinIO). Condensed
//! recipe, from an hcfs checkout at the pinned rev:
//!
//! ```text
//! # 1. MinIO + bucket (any S3-compatible store works)
//! minio server /tmp/minio-data --address 127.0.0.1:19011 &
//! aws --endpoint-url http://127.0.0.1:19011 s3api create-bucket --bucket hcfs-e2e
//!
//! # 2. Auth stub: two bearers -> two ss58s (owner in the USER slot,
//! #    member in the RECOVERY slot; the stub takes exactly two pairs)
//! HCFS_E2E_STUB_USER_TOKEN=<owner-bearer> HCFS_E2E_STUB_USER_SS58=<owner-ss58> \
//! HCFS_E2E_STUB_RECOVERY_TOKEN=<member-bearer> HCFS_E2E_STUB_RECOVERY_SS58=<member-ss58> \
//!   python3 scripts/e2e-auth-stub.py &
//! python3 scripts/e2e-entitlement-stub.py &
//!
//! # 3. hcfs-server with shared drives ON (fresh database)
//! DATABASE_URL=postgres://localhost/hcfs_desktop_e2e ARION_URL=http://127.0.0.1:1 \
//! HCFS_STORAGE_BACKEND=s3 HCFS_BACKUP_S3_BUCKET=hcfs-e2e \
//! HCFS_BACKUP_S3_ACCESS_KEY=minioadmin HCFS_BACKUP_S3_SECRET_KEY=minioadmin \
//! HCFS_BACKUP_S3_REGION=us-east-1 HCFS_BACKUP_S3_ENDPOINT=http://127.0.0.1:19011 \
//! HCFS_PORT=19999 HCFS_FEATURE_SHARED_DRIVES=1 \
//! HCFS_AUTH_VERIFY_URL=http://127.0.0.1:19998/auth/verify-token/ \
//! HCFS_DRIVE_ENTITLEMENT_URL=http://127.0.0.1:19997/api/drive/entitlement/ \
//! HCFS_DRIVE_ENTITLEMENT_TOKEN=throwaway \
//! BILLING_API_URL=http://127.0.0.1:1/ BILLING_USAGE_URL=http://127.0.0.1:1/ \
//! OTEL_EXPORTER_OTLP_ENDPOINT= cargo run -p hcfs-server &
//!
//! # 4. These tests
//! HCFS_DESKTOP_E2E_SERVER_URL=http://127.0.0.1:19999 \
//! HCFS_DESKTOP_E2E_BEARER_OWNER=<owner-bearer> \
//! HCFS_DESKTOP_E2E_BEARER_MEMBER=<member-bearer> \
//! HCFS_DESKTOP_E2E_OWNER_SS58=<owner-ss58> \
//! HCFS_DESKTOP_E2E_MEMBER_SS58=<member-ss58> \
//!   cargo test --test shared_drives_real_backend -- --ignored
//! ```
//!
//! All five vars are required; with any unset the tests print a skip note
//! and return Ok, so a default `cargo test` (and `--ignored` without the
//! env) stays hermetic and green. Set `HCFS_DESKTOP_E2E_REQUIRE=1` to turn
//! that skip into a panic — the `e2e-live` workflow sets it so a mistyped
//! or unprovisioned secret fails the lane instead of passing it with
//! nothing executed. The two ss58s MUST be the addresses the
//! auth stub returns for the two bearers — the server derives every
//! identity from the bearer, and a mismatch surfaces as grants sealed for
//! the wrong AAD. Every drive label is per-run unique, so the tests are
//! re-runnable against a persistent server database.

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;

use hcfs_client::client::{HcfsClient, HcfsClientConfig};
use hcfs_client::engine::events::{NoopCallbacks, SyncEvent, SyncEventHandler};
use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::{DriveSlot, SyncRunner, trigger_sync};

use tauri_project_lib::auth::account_key::account_key;
use tauri_project_lib::shared_drives::commands::{
    MemberDriveInstall, http_create_invite, http_list_memberships, http_remove_member, install_member_drive,
};
use tauri_project_lib::shared_drives::grant;
use tauri_project_lib::sync::events::SHARED_DRIVE_REVOKED_MARKER;
use tauri_project_lib::sync::identity::{DriveIdentity, MemberDriveIdentity, resolve_drive_identity};
use tauri_project_lib::utils::schema::ensure_table_schema;

// ── Environment ────────────────────────────────────────────────────────────

const SERVER_URL_ENV: &str = "HCFS_DESKTOP_E2E_SERVER_URL";
const BEARER_OWNER_ENV: &str = "HCFS_DESKTOP_E2E_BEARER_OWNER";
const BEARER_MEMBER_ENV: &str = "HCFS_DESKTOP_E2E_BEARER_MEMBER";
const OWNER_SS58_ENV: &str = "HCFS_DESKTOP_E2E_OWNER_SS58";
const MEMBER_SS58_ENV: &str = "HCFS_DESKTOP_E2E_MEMBER_SS58";
/// `=1` turns the quiet env-skip into a panic, so a live CI lane cannot
/// go green by silently not running these tests.
const REQUIRE_ENV: &str = "HCFS_DESKTOP_E2E_REQUIRE";

/// The two accounts' resolved live-lane parameters.
struct LiveEnv {
    server_url: String,
    owner_bearer: String,
    member_bearer: String,
    owner_ss58: String,
    member_ss58: String,
}

/// `Some(env)` when all five vars are set and non-empty, else `None` after a
/// skip note — or a panic when [`REQUIRE_ENV`] is `1`. Empty counts as unset
/// (a CI step forwarding an unconfigured secret materializes it as `""`, and
/// an empty bearer would 401 instead of skipping) — the
/// `folder_entries_real_backend::live_env` convention.
fn live_env() -> Option<LiveEnv> {
    let nonempty = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let vars = (
        nonempty(SERVER_URL_ENV),
        nonempty(BEARER_OWNER_ENV),
        nonempty(BEARER_MEMBER_ENV),
        nonempty(OWNER_SS58_ENV),
        nonempty(MEMBER_SS58_ENV),
    );
    let (Some(server_url), Some(owner_bearer), Some(member_bearer), Some(owner_ss58), Some(member_ss58)) = vars else {
        assert!(
            nonempty(REQUIRE_ENV).as_deref() != Some("1"),
            "{REQUIRE_ENV}=1 but {SERVER_URL_ENV}/{BEARER_OWNER_ENV}/{BEARER_MEMBER_ENV}/{OWNER_SS58_ENV}/{MEMBER_SS58_ENV} \
             are not all set — the live lane must not skip"
        );
        // `tracing::warn!` (not println) — the workspace denies stdout
        // prints; the `#[ignore]` attribute already documents the lane.
        tracing::warn!(
            "skipping shared_drives_real_backend: set {SERVER_URL_ENV}, {BEARER_OWNER_ENV}, {BEARER_MEMBER_ENV}, \
             {OWNER_SS58_ENV} and {MEMBER_SS58_ENV} to run against a live hcfs-server with \
             HCFS_FEATURE_SHARED_DRIVES=1 (see this file's module docs)"
        );
        return None;
    };
    Some(LiveEnv {
        server_url,
        owner_bearer,
        member_bearer,
        owner_ss58,
        member_ss58,
    })
}

// ── Fixtures (published BIP-39 vectors — never real wallets) ───────────────

/// The masters are key material only — the server never checks that a master
/// derives its account's ss58 (identity comes solely from the bearer), which
/// mirrors production OAuth accounts whose sync mnemonic derives a different
/// address than their login ss58.
const OWNER_MASTER: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const MEMBER_MASTER: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/// Both drive engines unlock with a fixed per-side drive password; the
/// member's is also what the seeded `hcfs_config` row decrypts to.
const OWNER_DRIVE_PW: &str = "owner-drive-pw";
const MEMBER_DRIVE_PW: &str = "drive-pw";

/// One shared `$HOME` for the process: `install_member_drive` writes the
/// member seal under `~/.hippius/drives/...`, and pointing HOME at a tempdir
/// keeps the run off the developer's real config tree. Same pattern (and
/// rationale) as `tests/shared_drive_server_mock.rs::TEST_HOME`.
static TEST_HOME: std::sync::LazyLock<PathBuf> = std::sync::LazyLock::new(|| {
    let dir = tempfile::TempDir::new().expect("home tempdir");
    let path = dir.path().to_path_buf();
    std::mem::forget(dir);
    unsafe {
        std::env::set_var("HOME", &path);
    }
    path
});

/// Per-run-unique owner drive label (`suffix` keeps the two tests in this
/// binary disjoint), so re-runs against a persistent server database never
/// collide on the `(owner_ss58, folder_hash)` namespace.
fn unique_label(suffix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after the Unix epoch")
        .as_nanos();
    format!("desktop-e2e-{suffix}-{}-{nanos}", std::process::id())
}

// ── Engine plumbing (the desktop's runner shape, minus the Tauri bridge) ───

/// Event capture standing in for the desktop's `TauriSyncBridge`: same
/// `SyncEventHandler` seam, but events land in a Vec the test can assert on.
#[derive(Default)]
struct CaptureHandler {
    events: std::sync::Mutex<Vec<SyncEvent>>,
}

impl SyncEventHandler for CaptureHandler {
    fn on_event(&self, event: SyncEvent) {
        self.events.lock().expect("capture lock").push(event);
    }
}

impl CaptureHandler {
    /// Every `SyncError` message captured so far, in arrival order.
    fn sync_errors(&self) -> Vec<String> {
        self.events
            .lock()
            .expect("capture lock")
            .iter()
            .filter_map(|e| match e {
                SyncEvent::SyncError { error, .. } => Some(error.clone()),
                _ => None,
            })
            .collect()
    }
}

/// Mirror of the desktop's `build_hcfs_config` (`sync/drive/config.rs`),
/// field-for-field: that helper is `pub(crate)`, and its identity threading
/// is pinned by its own unit tests — what THIS file adds is the live-server
/// proof that a config built from the resolved identity actually syncs.
fn engine_config(server_url: &str, bearer: &str, identity: &DriveIdentity) -> HcfsClientConfig {
    HcfsClientConfig {
        base_url: server_url.to_string(),
        bearer_token: bearer.to_string(),
        accept_invalid_certs: false,
        billing_bypass_token: None,
        ss58_address: identity.wire_ss58.clone(),
        folder_hash: identity.wire_folder_hash.clone(),
        read_timeout_ms: None,
        shared_drive_member: identity.is_member,
    }
}

/// One side's running engine: a real `SyncRunner` holding one registered
/// drive, plus the capture handler its events land in.
struct EngineSide {
    runner: Arc<SyncRunner>,
    handler: Arc<CaptureHandler>,
}

/// Build a runner and register `manager` under `label` — the
/// `lifecycle::register_drive` slot shape (runner-owned drives map, per-drive
/// cancel token, lock-free `sync_path` copy).
async fn engine_side(manager: DriveManager, label: &str, sync_root: &std::path::Path) -> EngineSide {
    let handler = Arc::new(CaptureHandler::default());
    let runner = Arc::new(SyncRunner::new(
        handler.clone() as Arc<dyn SyncEventHandler>,
        Arc::new(NoopCallbacks),
        reqwest::Client::new(),
    ));

    runner.register_label_root(label.to_string(), sync_root.to_path_buf());
    runner.drives.lock().await.insert(
        label.to_string(),
        DriveSlot {
            manager: Arc::new(TokioMutex::new(manager)),
            cancel_token: CancellationToken::new(),
            sync_path: sync_root.to_path_buf(),
        },
    );

    EngineSide { runner, handler }
}

/// Run full sync cycles until `pred` holds, panicking with `what` and the
/// captured error stream after the attempt budget. Cycles are triggered
/// manually (no background loop), so each attempt is one deterministic round.
async fn sync_until(side: &EngineSide, what: &str, mut pred: impl FnMut() -> bool) {
    const ATTEMPTS: usize = 15;
    for _ in 0..ATTEMPTS {
        trigger_sync(&side.runner).await;
        if pred() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    panic!(
        "condition not reached after {ATTEMPTS} sync cycles: {what}; captured sync errors: {:?}",
        side.handler.sync_errors()
    );
}

// ── DB seeding ─────────────────────────────────────────────────────────────

/// In-memory pool carrying the FULL production schema (member columns
/// included), so the rows the resolver and install read stay in lockstep
/// with production.
async fn live_pool() -> sqlx::SqlitePool {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.expect("open in-memory db");
    ensure_table_schema(&pool).await.expect("apply production schema");
    pool
}

/// Encrypted (v1) drive-password row for `account` — the production steady
/// state after `crypto::store::migrate_if_needed`, so `install_member_drive`
/// exercises the master-decrypt path a real account is on.
async fn seed_encrypted_drive_password(pool: &sqlx::SqlitePool, master: &str, account: &str, password: &str) {
    let key = tauri_project_lib::crypto::store::derive_key(master, account, tauri_project_lib::crypto::store::INFO_DRIVE_PASSWORD).expect("key");
    let sealed = tauri_project_lib::crypto::store::encrypt(&key, password).expect("encrypt pw");
    sqlx::query("INSERT INTO hcfs_config (owner, drive_password, encryption_version) VALUES (?, ?, 1)")
        .bind(account_key(account))
        .bind(&sealed)
        .execute(pool)
        .await
        .expect("seed hcfs_config");
}

/// The member drive's config dir under the pinned HOME — where
/// `install_member_drive` sealed the owner's folder mnemonic, and therefore
/// the config dir the member's engine must unlock from.
fn member_config_dir(member_ss58: &str, label: &str) -> PathBuf {
    TEST_HOME
        .join(".hippius")
        .join("drives")
        .join(account_key(member_ss58))
        .join(hcfs_client::drive::keys::folder_hash(label))
}

// ── Scenario builders ──────────────────────────────────────────────────────

/// The owner side of a scenario: an initialized, registered, engine-backed
/// drive. The TempDirs ride along so the roots outlive the phases.
struct OwnerDrive {
    root: tempfile::TempDir,
    identity: DriveIdentity,
    side: EngineSide,
    client: HcfsClient,
    folder_phrase: String,
}

/// Stand up an own drive the way the desktop does: a production-shaped
/// `sync_paths` row resolved through the REAL resolver (own-drive
/// passthrough), `init_new_drive`'s derivation (folder mnemonic from the
/// master), the `spawn_folder_registration` register call, and a runner slot.
async fn owner_drive_setup(env: &LiveEnv, label_suffix: &str) -> OwnerDrive {
    let label = unique_label(label_suffix);
    let root = tempfile::TempDir::new().expect("owner root");
    let cfg = tempfile::TempDir::new().expect("owner config dir");

    let pool = live_pool().await;
    sqlx::query("INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, ?, 'private', ?, 0)")
        .bind(account_key(&env.owner_ss58))
        .bind(root.path().to_str().expect("utf8 owner root"))
        .bind(&label)
        .execute(&pool)
        .await
        .expect("seed owner sync_paths row");
    let identity = resolve_drive_identity(&pool, &env.owner_ss58, &label)
        .await
        .expect("resolve owner identity");
    assert!(!identity.is_member, "an own drive must resolve as non-member");
    assert_eq!(identity.wire_folder_hash, hcfs_client::drive::keys::folder_hash(&label));

    let folder_phrase = hcfs_client::drive::keys::derive_folder_mnemonic(OWNER_MASTER, &label).expect("owner folder mnemonic");
    let mut manager = DriveManager::new(root.path().to_path_buf(), cfg.path().to_path_buf());
    manager
        .set_config(engine_config(&env.server_url, &env.owner_bearer, &identity))
        .expect("owner set_config");
    manager.init(OWNER_DRIVE_PW, Some(&folder_phrase)).await.expect("owner drive init");
    let uid = manager.unlock(OWNER_DRIVE_PW).expect("owner unlock");
    assert_eq!(
        uid,
        format!("{}_{}", env.owner_ss58, identity.wire_folder_hash),
        "own drive user_id is the account composite (the init funnel's assert)"
    );

    // The engine's config dir must outlive this function; TempDir would
    // delete it on drop, so leak it (OS temp cleanup reaps it).
    std::mem::forget(cfg);

    let client = HcfsClient::new(engine_config(&env.server_url, &env.owner_bearer, &identity)).expect("owner client");
    client
        .register_folder(&env.owner_ss58, &identity.wire_folder_hash, &label, Some("desktop-e2e-owner"))
        .await
        .expect("register owner folder");

    let side = engine_side(manager, &label, root.path()).await;
    OwnerDrive {
        root,
        identity,
        side,
        client,
        folder_phrase,
    }
}

/// The member side of a scenario: the installed local drive + its engine.
struct MemberDrive {
    root: tempfile::TempDir,
    side: EngineSide,
}

/// Run the whole member half: mint the invite through the desktop HTTP
/// layer, accept it with a grant sealed by the member (the console's accept
/// flow), then run `add_shared_drive`'s internals — memberships fetch, grant
/// open, `install_member_drive`, resolver, engine unlock — asserting the
/// contract at each seam.
async fn member_accept_and_install(env: &LiveEnv, http: &reqwest::Client, owner: &OwnerDrive) -> MemberDrive {
    let invite_token = http_create_invite(http, &env.server_url, &env.owner_bearer, &owner.identity.wire_folder_hash, 3600, 5)
        .await
        .expect("mint invite");

    // The `#k=` fragment entropy — `create_drive_invite`'s derivation.
    let fragment_entropy = grant::entropy_from_phrase(&owner.folder_phrase).expect("fragment entropy");

    let sealed = grant::seal_grant(MEMBER_MASTER, &env.member_ss58, &fragment_entropy).expect("seal grant");
    let accept_url = format!("{}/v1/drive-invites/{}/accept", env.server_url.trim_end_matches('/'), invite_token);
    let accept_resp = http
        .post(&accept_url)
        .header("Authorization", format!("Bearer {}", env.member_bearer))
        .json(&serde_json::json!({ "grant_blob": base64::engine::general_purpose::STANDARD.encode(&sealed) }))
        .send()
        .await
        .expect("accept request");
    assert!(accept_resp.status().is_success(), "accept must succeed, got {}", accept_resp.status());
    let accepted: hcfs_shared::network::AcceptDriveInviteResponse = accept_resp.json().await.expect("accept response parses");
    assert_eq!(accepted.owner_ss58, env.owner_ss58);
    assert_eq!(accepted.folder_hash, owner.identity.wire_folder_hash);
    assert!(!accepted.already_owner, "a real member accept must not read as the owner self-join");

    // add_shared_drive's lookup: memberships fetch → find the row → open the
    // stored grant → the exact entropy the owner minted with.
    let pool = live_pool().await;
    seed_encrypted_drive_password(&pool, MEMBER_MASTER, &env.member_ss58, MEMBER_DRIVE_PW).await;
    let memberships = http_list_memberships(http, &env.server_url, &env.member_bearer)
        .await
        .expect("list memberships");
    let entry = memberships
        .memberships
        .into_iter()
        .find(|m| m.owner_ss58 == env.owner_ss58 && m.folder_hash == owner.identity.wire_folder_hash)
        .expect("the accepted membership must be listed");
    let grant_bytes = base64::engine::general_purpose::STANDARD
        .decode(&entry.grant_blob)
        .expect("stored grant blob decodes");
    let opened = grant::open_grant(MEMBER_MASTER, &env.member_ss58, &grant_bytes).expect("open grant");
    assert_eq!(*opened, *fragment_entropy, "the stored grant must round-trip the owner's folder entropy");
    let phrase = zeroize::Zeroizing::new(bip39::Mnemonic::from_entropy(opened.as_ref()).expect("entropy is a mnemonic").to_string());

    let root = tempfile::TempDir::new().expect("member root");
    let member_identity_in = MemberDriveIdentity {
        owner_ss58: env.owner_ss58.clone(),
        wire_folder_hash: owner.identity.wire_folder_hash.clone(),
    };
    let installed = install_member_drive(
        &pool,
        MemberDriveInstall {
            account_id: &env.member_ss58,
            member: &member_identity_in,
            local_path: root.path().to_str().expect("utf8 member root"),
            display_label: &entry.display_label,
            folder_phrase: &phrase,
            master_mnemonic: MEMBER_MASTER,
        },
    )
    .await
    .expect("install member drive");

    // The installed row resolves to the OWNER's wire identity — the resolver
    // output every member-drive operation (init funnel included) runs on.
    let identity = resolve_drive_identity(&pool, &env.member_ss58, &installed.label)
        .await
        .expect("resolve member identity");
    assert!(identity.is_member);
    assert_eq!(identity.wire_ss58, env.owner_ss58);
    assert_eq!(identity.wire_folder_hash, owner.identity.wire_folder_hash);

    let cfg = member_config_dir(&env.member_ss58, &installed.label);
    let mut manager = DriveManager::new(root.path().to_path_buf(), cfg);
    manager
        .set_config(engine_config(&env.server_url, &env.member_bearer, &identity))
        .expect("member set_config");
    assert!(
        manager.is_initialized(),
        "the installed seal must make the member drive engine-ready with no init (a member config dir has no self-heal path)"
    );
    let uid = manager.unlock(MEMBER_DRIVE_PW).expect("member unlock");
    assert_eq!(
        uid,
        format!("{}_{}", env.owner_ss58, identity.wire_folder_hash),
        "member drive user_id is the OWNER composite (land mine 2's member shape)"
    );

    let side = engine_side(manager, &installed.label, root.path()).await;
    MemberDrive { root, side }
}

// ── Scenario 1: round-trips + owner-removes-member ─────────────────────────

/// Owner mints → member accepts + installs → files round-trip BOTH
/// directions → the owner removes the member (`remove_drive_member`'s owner
/// path, no `?owner=`) → the member's next cycle surfaces
/// [`SHARED_DRIVE_REVOKED_MARKER`] via the stage-2 memberships consult
/// (single-membership topology — the module docs' revocation shape 1) →
/// the member's local files are intact.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "live-lane: needs HCFS_DESKTOP_E2E_SERVER_URL + per-account bearers/ss58s and a running hcfs-server with HCFS_FEATURE_SHARED_DRIVES=1"]
async fn files_round_trip_and_member_removal_denies_the_member() {
    let Some(env) = live_env() else {
        return; // hermetic default stays green
    };
    let _home = &*TEST_HOME;
    let http = reqwest::Client::new();

    let owner = owner_drive_setup(&env, "rt").await;
    std::fs::write(owner.root.path().join("from-owner.txt"), b"hello from the owner").expect("write owner file");
    trigger_sync(&owner.side.runner).await;
    assert_eq!(owner.side.handler.sync_errors(), Vec::<String>::new(), "owner's first cycle must succeed");

    let member = member_accept_and_install(&env, &http, &owner).await;

    // Round-trip 1: the owner's file arrives at the member and decrypts.
    let member_copy = member.root.path().join("from-owner.txt");
    sync_until(&member.side, "owner's file downloads to the member", || member_copy.is_file()).await;
    assert_eq!(std::fs::read(&member_copy).expect("read member copy"), b"hello from the owner");

    // Round-trip 2: the member's file arrives at the owner and decrypts.
    std::fs::write(member.root.path().join("from-member.txt"), b"hello from the member").expect("write member file");
    trigger_sync(&member.side.runner).await;
    let owner_copy = owner.root.path().join("from-member.txt");
    sync_until(&owner.side, "member's file downloads to the owner", || owner_copy.is_file()).await;
    assert_eq!(std::fs::read(&owner_copy).expect("read owner copy"), b"hello from the member");
    assert_eq!(
        member.side.handler.sync_errors(),
        Vec::<String>::new(),
        "no member sync error may occur before the revocation"
    );

    // Revocation, shape 1: owner removes the member (owner path — no ?owner=).
    http_remove_member(
        &http,
        &env.server_url,
        &env.owner_bearer,
        &owner.identity.wire_folder_hash,
        &env.member_ss58,
        None,
    )
    .await
    .expect("owner removes member");

    // The two-stage arbiter (module docs, shape 1): the member's fetch is
    // denied with a 403, the owner-scoped listing is forbidden-shaped too
    // (single membership — this is exactly the topology stage 2 exists
    // for), and the memberships consult confirms the revocation, so the
    // surfaced error IS the marker — never the raw 403.
    let marker_seen = || member.side.handler.sync_errors().iter().any(|e| e == SHARED_DRIVE_REVOKED_MARKER);
    sync_until(&member.side, "revocation marker surfaces on the member", marker_seen).await;
    let errors = member.side.handler.sync_errors();
    assert!(
        errors.iter().all(|e| e == SHARED_DRIVE_REVOKED_MARKER),
        "a removed member must surface SHARED_DRIVE_REVOKED_MARKER, nothing else — got {errors:?}"
    );

    // Revocation is server-side only: the member's local files stay intact.
    assert_eq!(
        std::fs::read(&member_copy).expect("member copy after removal"),
        b"hello from the owner",
        "removal must not touch the member's local files"
    );
    assert_eq!(
        std::fs::read(member.root.path().join("from-member.txt")).expect("member's own file after removal"),
        b"hello from the member",
        "the member's own file survives too"
    );

    // The owner keeps full access after removing the member.
    trigger_sync(&owner.side.runner).await;
    assert_eq!(
        owner.side.handler.sync_errors(),
        Vec::<String>::new(),
        "the owner's drive must stay healthy after removing the member"
    );
}

// ── Scenario 2: the drive disappears → the mass-deletion guard ─────────────

/// Owner mints → member accepts + installs + syncs one file → the owner
/// unregisters the DRIVE (membership row survives) → the member's next
/// cycle surfaces [`SHARED_DRIVE_REVOKED_MARKER`]: the mass-deletion guard
/// trips, and the stage-1 listing (still authorized by the dangling
/// membership row) 200s without the folder, confirming the revocation
/// (module docs' shape 2). The intact-files assert stays the load-bearing
/// one: a guard regression here means a revoked drive wipes the member's
/// local copy.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "live-lane: needs HCFS_DESKTOP_E2E_SERVER_URL + per-account bearers/ss58s and a running hcfs-server with HCFS_FEATURE_SHARED_DRIVES=1"]
async fn drive_deletion_trips_the_mass_deletion_guard_on_the_member() {
    let Some(env) = live_env() else {
        return; // hermetic default stays green
    };
    let _home = &*TEST_HOME;
    let http = reqwest::Client::new();

    let owner = owner_drive_setup(&env, "rv").await;
    std::fs::write(owner.root.path().join("doomed.txt"), b"revocation fodder").expect("write owner file");
    trigger_sync(&owner.side.runner).await;

    let member = member_accept_and_install(&env, &http, &owner).await;
    let member_copy = member.root.path().join("doomed.txt");
    sync_until(&member.side, "owner's file downloads to the member", || member_copy.is_file()).await;

    // The owner deletes the drive server-side (the desktop's
    // delete_remote_folder call). The membership row survives, so the
    // member's next `get_state` still succeeds — with ZERO files — the
    // suspicious-empty guard refuses the implied mass deletion, and the
    // arbiter's stage-1 listing confirms the folder is gone: the marker.
    owner
        .client
        .unregister_folder(&env.owner_ss58, &owner.identity.wire_folder_hash)
        .await
        .expect("owner unregisters the drive");

    let marker_seen = || member.side.handler.sync_errors().iter().any(|e| e == SHARED_DRIVE_REVOKED_MARKER);
    sync_until(&member.side, "revocation marker surfaces on the member", marker_seen).await;
    let errors = member.side.handler.sync_errors();
    assert!(
        errors.iter().all(|e| e == SHARED_DRIVE_REVOKED_MARKER),
        "a deleted shared drive must surface SHARED_DRIVE_REVOKED_MARKER on the member, nothing else — got {errors:?}"
    );

    // Terminal for the member, but strictly server-side: local files intact.
    assert_eq!(
        std::fs::read(&member_copy).expect("member copy after revocation"),
        b"revocation fodder",
        "revocation must not touch the member's local files"
    );
}
