//! Integration tests for the encryption-at-rest migration.
//!
//! Verifies `migrate_if_needed` correctly encrypts plaintext `hcfs_config`
//! drive passwords, is idempotent, skips empty values, and rejects
//! wrong-key decryption. (The former sub-account half of this migration was
//! removed in the 2026-06-01 audit — it was write-only with no reader; the
//! drive-password half below is the live path consumed by
//! `sync::config::get_drive_password`.)

use sqlx::sqlite::SqlitePool;

const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_ACCOUNT_ID: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

async fn setup_db() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.expect("in-memory pool");
    // migrate_if_needed scans hcfs_config and updates rows by `id`.
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
    let pw1 = "first drive password";
    let pw2 = "second drive password";

    insert_plaintext(&pool, "owner-1", pw1).await;
    insert_plaintext(&pool, "owner-2", pw2).await;

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
    let original = "round trip drive password";

    insert_plaintext(&pool, "owner-1", original).await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("migrate");

    let (ciphertext,): (String,) = sqlx::query_as("SELECT drive_password FROM hcfs_config WHERE owner = 'owner-1'")
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
    let original = "idempotent drive password";

    insert_plaintext(&pool, "owner-1", original).await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("first migrate");
    let (after_first,): (String,) = sqlx::query_as("SELECT drive_password FROM hcfs_config WHERE owner = 'owner-1'")
        .fetch_one(&pool)
        .await
        .expect("read after first");

    // Second migration — the row is already version 1, so it must be a no-op.
    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("second migrate");
    let (after_second,): (String,) = sqlx::query_as("SELECT drive_password FROM hcfs_config WHERE owner = 'owner-1'")
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
    insert_plaintext(&pool, "owner-1", "secret drive password").await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("migrate");

    let (ciphertext,): (String,) = sqlx::query_as("SELECT drive_password FROM hcfs_config WHERE owner = 'owner-1'")
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

    insert_plaintext(&pool, "owner-empty", "").await;
    insert_plaintext(&pool, "owner-spaces", "   ").await;
    insert_plaintext(&pool, "owner-real", "real drive password").await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .expect("migrate");

    let (ver_real,): (i32,) = sqlx::query_as("SELECT encryption_version FROM hcfs_config WHERE owner = 'owner-real'")
        .fetch_one(&pool)
        .await
        .expect("read real");
    assert_eq!(ver_real, 1);

    // Empty-string rows are filtered by the SQL `!= ''`; whitespace-only rows are
    // selected by SQL but skipped by the `trim()` guard — both stay version 0.
    let (ver_empty,): (i32,) = sqlx::query_as("SELECT encryption_version FROM hcfs_config WHERE owner = 'owner-empty'")
        .fetch_one(&pool)
        .await
        .expect("read empty");
    assert_eq!(ver_empty, 0, "empty drive password must not be migrated");

    let (ver_spaces,): (i32,) = sqlx::query_as("SELECT encryption_version FROM hcfs_config WHERE owner = 'owner-spaces'")
        .fetch_one(&pool)
        .await
        .expect("read spaces");
    assert_eq!(ver_spaces, 0, "whitespace-only drive password must not be migrated");
}
