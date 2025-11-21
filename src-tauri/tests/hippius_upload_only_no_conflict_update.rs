// tests/hippius_upload_only_no_conflict_update.rs

use anyhow::{Context, Result};
use uuid::Uuid;

#[path = "hippius_policy_harness.rs"]
mod harness;
use harness::*;

/// Return "dir/stem" prefix (no extension) for `key` (e.g., "pair/foo.txt" -> "pair/foo").
fn stem_prefix(key: &str) -> String {
    let (dir, base) = match key.rfind('/') {
        Some(i) => (&key[..=i], &key[i + 1..]), // include trailing '/'
        None => ("", key),
    };
    let stem = match base.rfind('.') {
        Some(j) => &base[..j],
        None => base,
    };
    format!("{dir}{stem}")
}

/// Assert that only `key` exists remotely and locally for its "dir/stem" prefix.
async fn assert_singleton_no_conflict(
    a: &harness::ClientCtx,
    b: &harness::ClientCtx,
    bucket: &str,
    key: &str,
) -> Result<()> {
    let pref = stem_prefix(key);

    // Remote: exactly 1 key for this prefix, and it is `key`
    let rks = list_remote_keys_with_prefix(&a.s3, bucket, &pref).await?;
    let set: std::collections::HashSet<_> = rks.into_iter().collect();
    anyhow::ensure!(
        set.len() == 1 && set.contains(key),
        "remote must contain only {key} for prefix {pref}; got: {:?}",
        set
    );

    // Locals: both clients have exactly the `key` and no siblings
    for ctx in [a, b] {
        let locals = list_local_pair_keys(&ctx.local_root)?;
        let mut siblings: Vec<_> = locals
            .into_iter()
            .filter(|k| k.starts_with(&pref))
            .collect();
        siblings.sort();
        anyhow::ensure!(
            siblings.len() == 1 && siblings[0] == key,
            "[UploadOnly] {} must not create conflict siblings for {}; got {:?}",
            ctx.name,
            key,
            siblings
        );
    }
    Ok(())
}

#[test]
fn upload_only_no_conflict_on_shared_update() -> Result<()> {
    // Larger OS thread stack, mirror other suites
    let os_stack = std::env::var("SMOKE_OS_STACK_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(16 * 1024 * 1024);

    let jh = std::thread::Builder::new()
        .name("hippius_upload_only_no_conflict_update".into())
        .stack_size(os_stack)
        .spawn(|| -> Result<()> {
            let worker_threads = std::env::var("SMOKE_WORKER_THREADS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(4);
            let worker_stack = std::env::var("SMOKE_STACK_BYTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8 * 1024 * 1024);

            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(worker_threads)
                .thread_stack_size(worker_stack)
                .enable_all()
                .build()
                .expect("tokio runtime");

            rt.block_on(async {
                // Boot stack & bucket
                let boot = boot_stack().await?;
                let s3c = s3_client(&boot.s3_endpoint).await?;
                let bucket = new_bucket(&s3c).await?;

                // Controls
                let rounds_conflict = env_usize("SMOKE_SYNC_ROUNDS_CONFLICT", 5);
                let check_iters = env_usize("SMOKE_CHECK_ITERS", 5);

                // Two UploadOnly clients
                let tag8 = "smoketag";
                let (a_ctx, _ta) = make_client_ctx(
                    "A",
                    &boot.s3_endpoint,
                    &bucket,
                    format!("{tag8}-A"),
                    harness::DeletePolicy::UploadOnly,
                )
                .await?;
                let (b_ctx, _tb) = make_client_ctx(
                    "B",
                    &boot.s3_endpoint,
                    &bucket,
                    format!("{tag8}-B"),
                    harness::DeletePolicy::UploadOnly,
                )
                .await?;

                // ---- Scenario 1: both have the file; A uploads a new version; B must adopt without conflict rename.
                let key = format!("pair/noconf-upl-{}.txt", Uuid::new_v4().simple());

                // Seed both sides with identical content (UploadOnly never downloads brand-new files)
                seed_shared_file_no_conflict_upload_only(&a_ctx, &b_ctx, &key, "seed-shared\n", check_iters).await?;

                // A updates to a newer version
                write_one(&a_ctx.local_root, &key, "updated-by-A\n").await?;

                // Converge
                for _ in 0..rounds_conflict {
                    sync_both(&a_ctx, &b_ctx, 1).await?;
                }

                // B must adopt the update (no rename)
                let b_body = read_local_text(&b_ctx.local_root, &key)?;
                assert!(
                    b_body.contains("updated-by-A"),
                    "[UploadOnly] B must *download and adopt* A's new version for {}",
                    key
                );

                // Remote must reflect the new content
                let r_body = read_remote_text(&a_ctx.s3, &bucket, &key).await?;
                assert!(r_body.contains("updated-by-A"), "remote body must be updated");

                // No conflict siblings produced anywhere (A->B direction).
                assert_singleton_no_conflict(&a_ctx, &b_ctx, &bucket, &key).await?;

                // ---- Scenario 2: B updates the shared file; A must adopt without triggering conflict resolution.
                write_one(&b_ctx.local_root, &key, "updated-by-B\n").await?;

                for _ in 0..rounds_conflict {
                    sync_both(&a_ctx, &b_ctx, 1).await?;
                }

                let a_body = read_local_text(&a_ctx.local_root, &key)?;
                let b_body2 = read_local_text(&b_ctx.local_root, &key)?;
                assert!(
                    a_body.contains("updated-by-B") && b_body2.contains("updated-by-B"),
                    "[UploadOnly] both clients must adopt B's updated body for {} (no conflict rename)",
                    key
                );

                let r_body2 = read_remote_text(&a_ctx.s3, &bucket, &key).await?;
                assert!(
                    r_body2.contains("updated-by-B"),
                    "remote body must be updated to B's version"
                );

                // Still no conflict siblings in either direction.
                assert_singleton_no_conflict(&a_ctx, &b_ctx, &bucket, &key).await?;

                teardown_stack(&boot).await?;
                Ok(())
            })
        })?;

    let inner = jh.join().map_err(|e| {
        if let Some(s) = e.downcast_ref::<&str>() {
            anyhow::anyhow!("test thread panicked: {s}")
        } else if let Some(s) = e.downcast_ref::<String>() {
            anyhow::anyhow!("test thread panicked: {s}")
        } else {
            anyhow::anyhow!("test thread panicked (unknown payload)")
        }
    })?;
    inner
}
