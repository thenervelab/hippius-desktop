//! Integration tests for the encryption-at-rest migration.
//!
//! Verifies `migrate_if_needed` correctly encrypts plaintext sub-account
//! seed phrases, handles idempotency, and rejects wrong-key decryption.

use sqlx::sqlite::SqlitePool;

const TEST_MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_ACCOUNT_ID: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

async fn setup_db() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

    sqlx::query(
        "CREATE TABLE sub_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            sub_account_seed_phrase TEXT NOT NULL,
            encryption_version INTEGER NOT NULL DEFAULT 0,
            created_at TEXT
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

async fn insert_plaintext(pool: &SqlitePool, account_id: &str, phrase: &str) {
    sqlx::query(
        "INSERT INTO sub_accounts (account_id, sub_account_seed_phrase, encryption_version)
         VALUES (?, ?, 0)",
    )
    .bind(account_id)
    .bind(phrase)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn migrate_encrypts_plaintext_rows() {
    let pool = setup_db().await;
    let phrase1 = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
    let phrase2 = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";

    insert_plaintext(&pool, "acct-1", phrase1).await;
    insert_plaintext(&pool, "acct-2", phrase2).await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .unwrap();

    let rows: Vec<(String, i32)> = sqlx::query_as(
        "SELECT sub_account_seed_phrase, encryption_version FROM sub_accounts ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(rows.len(), 2);
    for (ciphertext, ver) in &rows {
        assert_eq!(*ver, 1, "encryption_version should be 1");
        assert_ne!(ciphertext, phrase1, "phrase should be encrypted, not plaintext");
        assert_ne!(ciphertext, phrase2, "phrase should be encrypted, not plaintext");
    }
}

#[tokio::test]
async fn migrate_round_trips_correctly() {
    let pool = setup_db().await;
    let original = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

    insert_plaintext(&pool, "acct-1", original).await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .unwrap();

    let (ciphertext,): (String,) = sqlx::query_as(
        "SELECT sub_account_seed_phrase FROM sub_accounts WHERE account_id = 'acct-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let key = tauri_project_lib::crypto::store::sub_account_key(TEST_MNEMONIC, TEST_ACCOUNT_ID).unwrap();
    let decrypted = tauri_project_lib::crypto::store::decrypt_or_plaintext(&key, &ciphertext, 1).unwrap();
    assert_eq!(&*decrypted, original);
}

#[tokio::test]
async fn migrate_is_idempotent() {
    let pool = setup_db().await;
    let original = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

    insert_plaintext(&pool, "acct-1", original).await;

    // First migration
    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .unwrap();

    let (after_first,): (String,) = sqlx::query_as(
        "SELECT sub_account_seed_phrase FROM sub_accounts WHERE account_id = 'acct-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    // Second migration — should be a no-op
    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .unwrap();

    let (after_second,): (String,) = sqlx::query_as(
        "SELECT sub_account_seed_phrase FROM sub_accounts WHERE account_id = 'acct-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(after_first, after_second, "Second migration should not change the ciphertext");

    // Still decrypts to original
    let key = tauri_project_lib::crypto::store::sub_account_key(TEST_MNEMONIC, TEST_ACCOUNT_ID).unwrap();
    let decrypted = tauri_project_lib::crypto::store::decrypt_or_plaintext(&key, &after_second, 1).unwrap();
    assert_eq!(&*decrypted, original);
}

#[tokio::test]
async fn decrypt_with_wrong_mnemonic_fails() {
    let pool = setup_db().await;
    let original = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

    insert_plaintext(&pool, "acct-1", original).await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .unwrap();

    let (ciphertext,): (String,) = sqlx::query_as(
        "SELECT sub_account_seed_phrase FROM sub_accounts WHERE account_id = 'acct-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    // Different mnemonic -> different key -> decryption should fail
    let wrong_mnemonic = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
    let wrong_key = tauri_project_lib::crypto::store::sub_account_key(wrong_mnemonic, TEST_ACCOUNT_ID).unwrap();
    let result = tauri_project_lib::crypto::store::decrypt_or_plaintext(&wrong_key, &ciphertext, 1);
    assert!(result.is_err(), "Decryption with wrong key should fail");
}

#[tokio::test]
async fn migrate_skips_empty_phrases() {
    let pool = setup_db().await;

    insert_plaintext(&pool, "acct-empty", "").await;
    insert_plaintext(&pool, "acct-spaces", "   ").await;
    insert_plaintext(&pool, "acct-real", "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong").await;

    tauri_project_lib::crypto::store::migrate_if_needed(&pool, TEST_MNEMONIC, TEST_ACCOUNT_ID)
        .await
        .unwrap();

    let (ver,): (i32,) = sqlx::query_as(
        "SELECT encryption_version FROM sub_accounts WHERE account_id = 'acct-real'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(ver, 1);

    let (ver_empty,): (i32,) = sqlx::query_as(
        "SELECT encryption_version FROM sub_accounts WHERE account_id = 'acct-empty'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(ver_empty, 0, "Empty phrase should not be migrated");

    // Whitespace-only row: selected by SQL (not empty string) but skipped by trim() check
    let (ver_spaces,): (i32,) = sqlx::query_as(
        "SELECT encryption_version FROM sub_accounts WHERE account_id = 'acct-spaces'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(ver_spaces, 0, "Whitespace-only phrase should not be migrated");
}
