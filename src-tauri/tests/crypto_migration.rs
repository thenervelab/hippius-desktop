//! Integration tests for the encryption-at-rest migration.
//!
//! Verifies `migrate_if_needed` correctly encrypts plaintext `hcfs_config`
//! drive passwords, is idempotent, skips empty values, rejects wrong-key
//! decryption, and — critically — only ever touches the *restoring account's*
//! rows (R-04). This drive-password path is the live one consumed by
//! `sync::config::get_drive_password`.

use sqlx::sqlite::SqlitePool;

const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_ACCOUNT_ID: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

/// Mirrors `account_key()` from `auth/account_key.rs` (16-hex truncated
/// SHA-256). `auth` is not a public module of the lib crate, so the test
/// suite reproduces the owner-key derivation locally — the same pattern used
/// by `tests/auth_tokens.rs` and `tests/drive_status.rs`.
fn account_key(account_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(account_id.as_bytes());
    hex::encode(&hash[..8])
}

async fn setup_db() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("in-memory pool");
    // Mirror the production `hcfs_config` shape: rows are partitioned by
    // `owner`, and the migration scans/updates only the current account's rows.
    sqlx::query(
        "CREATE TABLE hcfs_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL DEFAULT '',
            drive_password TEXT NOT NULL DEFAULT '',
            encryption_version INTEGER NOT NULL DEFAULT 0
        )",
    )
    .execute(&pool)
    .await
    .expect("create hcfs_config");
    pool
}

async fn insert_plaintext(pool: &SqlitePool, owner: &str, drive_password: &str) {
    sqlx::query("INSERT INTO hcfs_config (owner, drive_password, encryption_version) VALUES (?, ?, 0)")
        .bind(owner)
        .bind(drive_password)
        .execute(pool)
        .await
        .expect("insert plaintext drive_password");
}

#[tokio::test]
async fn migrate_encrypts_plaintext_rows() {
    let pool = setup_db().await;
    let owner = account_key(TEST_ACCOUNT_ID);
    let pw1 = "first drive password";
    let pw2 = "second drive password";

    insert_plaintext(&pool, &owner, pw1).await;
    insert_plaintext(&pool, &owner, pw2).await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("migrate");

    let rows: Vec<(String, i32)> = sqlx::query_as("SELECT drive_password, encryption_version FROM hcfs_config ORDER BY id")
        .fetch_all(&pool)
        .await
        .expect("read rows");

    assert_eq!(rows.len(), 2);
    for (ciphertext, ver) in &rows {
        assert_eq!(*ver, 1, "encryption_version should be 1");
        assert_ne!(ciphertext, pw1, "drive password should be encrypted, not plaintext");
        assert_ne!(ciphertext, pw2, "drive password should be encrypted, not plaintext");
    }
}

#[tokio::test]
async fn migrate_round_trips_correctly() {
    let pool = setup_db().await;
    let owner = account_key(TEST_ACCOUNT_ID);
    let original = "round trip drive password";

    insert_plaintext(&pool, &owner, original).await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("migrate");

    let (ciphertext,): (String,) = sqlx::query_as("SELECT drive_password FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .expect("read ciphertext");

    let key = tauri_project_lib::crypto::store::drive_password_key(TEST_MNEMONIC, TEST_ACCOUNT_ID).expect("derive key");
    let decrypted = tauri_project_lib::crypto::store::decrypt(&key, &ciphertext).expect("decrypt");
    assert_eq!(&*decrypted, original);
}

#[tokio::test]
async fn migrate_is_idempotent() {
    let pool = setup_db().await;
    let owner = account_key(TEST_ACCOUNT_ID);
    let original = "idempotent drive password";

    insert_plaintext(&pool, &owner, original).await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("first migrate");
    let (after_first,): (String,) = sqlx::query_as("SELECT drive_password FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .expect("read after first");

    // Second migration — the row is already version 1, so it must be a no-op.
    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("second migrate");
    let (after_second,): (String,) = sqlx::query_as("SELECT drive_password FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .expect("read after second");

    assert_eq!(after_first, after_second, "second migration must not re-encrypt");

    let key = tauri_project_lib::crypto::store::drive_password_key(TEST_MNEMONIC, TEST_ACCOUNT_ID).expect("derive key");
    let decrypted = tauri_project_lib::crypto::store::decrypt(&key, &after_second).expect("decrypt");
    assert_eq!(&*decrypted, original);
}

#[tokio::test]
async fn decrypt_with_wrong_mnemonic_fails() {
    let pool = setup_db().await;
    let owner = account_key(TEST_ACCOUNT_ID);
    insert_plaintext(&pool, &owner, "secret drive password").await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("migrate");

    let (ciphertext,): (String,) = sqlx::query_as("SELECT drive_password FROM hcfs_config WHERE owner = ?")
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .expect("read ciphertext");

    // A different mnemonic derives a different key, so AEAD decryption must fail.
    let wrong_mnemonic = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    let wrong_key = tauri_project_lib::crypto::store::drive_password_key(wrong_mnemonic, TEST_ACCOUNT_ID).expect("derive wrong key");
    let result = tauri_project_lib::crypto::store::decrypt(&wrong_key, &ciphertext);
    assert!(result.is_err(), "decryption with the wrong key must fail");
}

#[tokio::test]
async fn migrate_skips_empty_values() {
    let pool = setup_db().await;
    let owner = account_key(TEST_ACCOUNT_ID);

    // All three rows belong to the migrating account; empty/whitespace must be
    // left at version 0 while the real password is encrypted. Rows are matched
    // by value (not owner) because they share one owner.
    insert_plaintext(&pool, &owner, "").await;
    insert_plaintext(&pool, &owner, "   ").await;
    insert_plaintext(&pool, &owner, "real drive password").await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("migrate");

    // Exactly one row (the real password) was encrypted to version 1.
    let (migrated_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM hcfs_config WHERE encryption_version = 1")
        .fetch_one(&pool)
        .await
        .expect("count migrated");
    assert_eq!(migrated_count, 1, "only the non-empty password should migrate");

    // Empty-string rows are filtered by the SQL `!= ''`; whitespace-only rows are
    // selected by SQL but skipped by the `trim()` guard — both stay version 0.
    let (ver_empty,): (i32,) = sqlx::query_as("SELECT encryption_version FROM hcfs_config WHERE drive_password = ''")
        .fetch_one(&pool)
        .await
        .expect("read empty");
    assert_eq!(ver_empty, 0, "empty drive password must not be migrated");

    let (ver_spaces,): (i32,) = sqlx::query_as("SELECT encryption_version FROM hcfs_config WHERE drive_password = '   '")
        .fetch_one(&pool)
        .await
        .expect("read spaces");
    assert_eq!(ver_spaces, 0, "whitespace-only drive password must not be migrated");
}

/// R-04 regression: the migration must be scoped to the restoring account.
/// A second account's lingering plaintext row must NOT be re-encrypted under
/// the restoring account's key — doing so would seal it shut and permanently
/// lock that account out of its own sync config (irreversible data loss).
#[tokio::test]
async fn migrate_leaves_other_accounts_rows_untouched() {
    let pool = setup_db().await;

    // A distinct account id (the value need not be a real SS58 — `account_key`
    // and `derive_key` both treat it as opaque bytes).
    const ACCOUNT_B_ID: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
    let owner_a = account_key(TEST_ACCOUNT_ID);
    let owner_b = account_key(ACCOUNT_B_ID);
    assert_ne!(owner_a, owner_b, "test accounts must map to distinct owners");

    let pw_a = "account A drive password";
    let pw_b = "account B drive password";
    insert_plaintext(&pool, &owner_a, pw_a).await;
    insert_plaintext(&pool, &owner_b, pw_b).await;

    // Account A restores its session and runs the migration.
    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("migrate A");

    // A's row is encrypted at version 1.
    let (a_pw, a_ver): (String, i32) = sqlx::query_as("SELECT drive_password, encryption_version FROM hcfs_config WHERE owner = ?")
        .bind(&owner_a)
        .fetch_one(&pool)
        .await
        .expect("read A");
    assert_eq!(a_ver, 1, "the restoring account's row must be migrated");
    assert_ne!(a_pw, pw_a, "the restoring account's password must be encrypted");

    // B's row is completely untouched: still plaintext, still version 0.
    let (b_pw, b_ver): (String, i32) = sqlx::query_as("SELECT drive_password, encryption_version FROM hcfs_config WHERE owner = ?")
        .bind(&owner_b)
        .fetch_one(&pool)
        .await
        .expect("read B");
    assert_eq!(b_ver, 0, "another account's row must not be migrated");
    assert_eq!(b_pw, pw_b, "another account's plaintext must be left intact");

    // And B can still migrate and round-trip under ITS OWN key afterwards —
    // proving it was never sealed under A's key.
    let b_mnemonic = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    tauri_project_lib::crypto::store::migrate_if_needed(&pool, b_mnemonic, ACCOUNT_B_ID)
        .await
        .expect("migrate B");
    let (b_ciphertext,): (String,) = sqlx::query_as("SELECT drive_password FROM hcfs_config WHERE owner = ?")
        .bind(&owner_b)
        .fetch_one(&pool)
        .await
        .expect("read B ciphertext");
    let b_key = tauri_project_lib::crypto::store::drive_password_key(b_mnemonic, ACCOUNT_B_ID).expect("derive B key");
    let b_decrypted = tauri_project_lib::crypto::store::decrypt(&b_key, &b_ciphertext).expect("decrypt B");
    assert_eq!(&*b_decrypted, pw_b, "B must round-trip under its own key");
}
