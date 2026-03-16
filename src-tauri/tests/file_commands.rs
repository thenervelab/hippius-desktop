//! Tests for file command path resolution and export operations.
//!
//! Uses temporary directories and in-memory SQLite to validate that
//! subfolder file paths are resolved and exported correctly.

use sqlx::sqlite::SqlitePool;
use std::path::Path;
use tokio::fs;

async fn setup_db() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sync_paths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            path TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'private',
            label TEXT NOT NULL DEFAULT 'default',
            timestamp INTEGER NOT NULL DEFAULT 0,
            UNIQUE(owner, label)
        )",
    )
    .execute(&pool)
    .await
    .unwrap();

    pool
}

/// Helper: derive the account key the same way the app does (SHA-256 hex of address).
fn account_key(address: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::new().chain_update(address.as_bytes()).finalize())
}

/// Helper: resolve a file path the same way the Rust command does, but directly
/// against the provided pool so we don't depend on the global `DB_POOL` singleton.
async fn resolve_file_path(
    pool: &SqlitePool,
    account_id: &str,
    label: &str,
    file_name: &str,
) -> Result<String, String> {
    // Reject path traversal attempts — slashes are allowed for subfolder access
    if file_name.contains("..") {
        return Err("Invalid file name".to_string());
    }

    let owner = account_key(account_id);

    let result: Option<(String,)> =
        sqlx::query_as("SELECT path FROM sync_paths WHERE owner = ? AND label = ?")
            .bind(&owner)
            .bind(label)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("Failed to look up sync path: {e}"))?;

    let sync_path = result
        .map(|(p,)| p)
        .ok_or_else(|| format!("No sync path configured for label '{label}'"))?;

    let full_path = Path::new(&sync_path).join(file_name);

    let canonical_parent = Path::new(&sync_path)
        .canonicalize()
        .map_err(|e| format!("Invalid sync path: {e}"))?;
    let canonical_file = full_path
        .canonicalize()
        .map_err(|_| format!("File not found: {file_name}"))?;
    if !canonical_file.starts_with(&canonical_parent) {
        return Err("Path escapes sync folder".to_string());
    }

    Ok(canonical_file.to_string_lossy().to_string())
}

/// Insert a sync path row for testing.
async fn insert_sync_path(pool: &SqlitePool, account_id: &str, path: &str, label: &str) {
    let owner = account_key(account_id);
    sqlx::query(
        "INSERT INTO sync_paths (owner, path, type, label, timestamp) VALUES (?, ?, 'private', ?, 0)",
    )
    .bind(&owner)
    .bind(path)
    .bind(label)
    .execute(pool)
    .await
    .unwrap();
}

/// Root-level file resolves correctly.
#[tokio::test]
async fn resolve_root_level_file() {
    let pool = setup_db().await;
    let tmp = tempfile::tempdir().unwrap();
    let sync_root = tmp.path().to_str().unwrap();

    // Create a file at root level
    fs::write(tmp.path().join("test.png"), b"image data").await.unwrap();

    insert_sync_path(&pool, "5ABC", sync_root, "default").await;

    let result = resolve_file_path(&pool, "5ABC", "default", "test.png").await;
    assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
    assert!(result.unwrap().ends_with("test.png"));
}

/// Subfolder file resolves correctly with slash in file_name.
#[tokio::test]
async fn resolve_subfolder_file() {
    let pool = setup_db().await;
    let tmp = tempfile::tempdir().unwrap();
    let sync_root = tmp.path().to_str().unwrap();

    // Create nested folder structure
    let subfolder = tmp.path().join("default").join("sub-folder");
    fs::create_dir_all(&subfolder).await.unwrap();
    fs::write(subfolder.join("report.pdf"), b"pdf content").await.unwrap();

    insert_sync_path(&pool, "5ABC", sync_root, "default").await;

    let result = resolve_file_path(
        &pool,
        "5ABC",
        "default",
        "default/sub-folder/report.pdf",
    )
    .await;
    assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
    assert!(result.unwrap().ends_with("default/sub-folder/report.pdf"));
}

/// Path traversal using ".." is rejected.
#[tokio::test]
async fn reject_path_traversal() {
    let pool = setup_db().await;
    let tmp = tempfile::tempdir().unwrap();
    let sync_root = tmp.path().to_str().unwrap();

    insert_sync_path(&pool, "5ABC", sync_root, "default").await;

    let result = resolve_file_path(&pool, "5ABC", "default", "../etc/passwd").await;
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), "Invalid file name");
}

/// Non-existent file returns an error.
#[tokio::test]
async fn resolve_nonexistent_file() {
    let pool = setup_db().await;
    let tmp = tempfile::tempdir().unwrap();
    let sync_root = tmp.path().to_str().unwrap();

    insert_sync_path(&pool, "5ABC", sync_root, "default").await;

    let result = resolve_file_path(&pool, "5ABC", "default", "does-not-exist.txt").await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("File not found"));
}

/// No sync path configured returns an error.
#[tokio::test]
async fn resolve_missing_sync_path() {
    let pool = setup_db().await;

    let result = resolve_file_path(&pool, "5ABC", "default", "file.txt").await;
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("No sync path configured"));
}

/// Export copies a subfolder file to the output location.
#[tokio::test]
async fn export_subfolder_file() {
    let tmp = tempfile::tempdir().unwrap();
    let sync_root = tmp.path().join("sync");
    let subfolder = sync_root.join("default").join("nested");
    fs::create_dir_all(&subfolder).await.unwrap();
    fs::write(subfolder.join("data.csv"), b"a,b,c\n1,2,3").await.unwrap();

    let output_dir = tmp.path().join("output");
    fs::create_dir_all(&output_dir).await.unwrap();
    let output_file = output_dir.join("data.csv");

    // Replicate what export_file does: sync_path.join(file_name) with subfolder path
    let source = sync_root.join("default/nested/data.csv");
    assert!(source.exists(), "Source file should exist");

    tokio::fs::copy(&source, &output_file).await.unwrap();
    assert!(output_file.exists(), "Output file should exist after export");

    let content = tokio::fs::read_to_string(&output_file).await.unwrap();
    assert_eq!(content, "a,b,c\n1,2,3");
}

// ---------------------------------------------------------------------------
// dir_size_recursive tests
//
// The function lives in the binary crate and can't be imported directly, so we
// replicate the exact same logic here to validate its behaviour in isolation.
// ---------------------------------------------------------------------------

/// Mirror of `commands::file_commands::dir_size_recursive` for testing.
async fn dir_size_recursive(path: &Path) -> u64 {
    let mut total: u64 = 0;
    let Ok(mut dir) = tokio::fs::read_dir(path).await else {
        return 0;
    };
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if meta.is_dir() {
            total += Box::pin(dir_size_recursive(&entry.path())).await;
        } else {
            total += meta.len();
        }
    }
    total
}

/// Empty directory should report size 0.
#[tokio::test]
async fn dir_size_empty_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let size = dir_size_recursive(tmp.path()).await;
    assert_eq!(size, 0);
}

/// Directory with only regular files sums their sizes.
#[tokio::test]
async fn dir_size_flat_files() {
    let tmp = tempfile::tempdir().unwrap();
    // 10 bytes + 20 bytes = 30 bytes
    fs::write(tmp.path().join("a.txt"), &[0u8; 10]).await.unwrap();
    fs::write(tmp.path().join("b.txt"), &[0u8; 20]).await.unwrap();
    let size = dir_size_recursive(tmp.path()).await;
    assert_eq!(size, 30);
}

/// Nested directories are summed recursively.
#[tokio::test]
async fn dir_size_nested_folders() {
    let tmp = tempfile::tempdir().unwrap();
    let sub = tmp.path().join("sub");
    let deep = sub.join("deep");
    fs::create_dir_all(&deep).await.unwrap();

    fs::write(tmp.path().join("root.txt"), &[0u8; 5]).await.unwrap();
    fs::write(sub.join("mid.txt"), &[0u8; 15]).await.unwrap();
    fs::write(deep.join("leaf.txt"), &[0u8; 25]).await.unwrap();

    let size = dir_size_recursive(tmp.path()).await;
    assert_eq!(size, 45); // 5 + 15 + 25
}

/// Hidden files (starting with '.') are excluded from the total.
#[tokio::test]
async fn dir_size_excludes_hidden_files() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("visible.txt"), &[0u8; 10]).await.unwrap();
    fs::write(tmp.path().join(".hidden"), &[0u8; 100]).await.unwrap();

    let hidden_dir = tmp.path().join(".hidden_dir");
    fs::create_dir_all(&hidden_dir).await.unwrap();
    fs::write(hidden_dir.join("secret.txt"), &[0u8; 200]).await.unwrap();

    let size = dir_size_recursive(tmp.path()).await;
    assert_eq!(size, 10); // only visible.txt counts
}

/// Non-existent path returns 0 instead of an error.
#[tokio::test]
async fn dir_size_nonexistent_path() {
    let size = dir_size_recursive(Path::new("/tmp/does_not_exist_hippius_test")).await;
    assert_eq!(size, 0);
}
