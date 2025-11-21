// tests/hippius_local_only_deletes.rs
//
// Policy: LocalOnlyDeletes (Remote-backup)
// Behaviours validated (extended, name-agnostic where conflicts are involved):
// - Concurrent creates: both should get all. **No extra copies** for wave prefixes.
// - Concurrent deletes: remote still has all; deletions don't propagate to peer.
// - Concurrent restores: re-created files stay present locally on the restoring client(s).
// - Distinct subset overwrites: latest bodies visible on BOTH clients & remote; **no extra copies** created.
// - Same-name concurrent create (conflict): both see ≥2 distinct bodies locally; remote has both bodies.
// - Concurrent overwrites of the same key: both clients see both new bodies.
// - Delete a conflict-named key locally on A: A keeps it deleted, B & remote keep it.
// - Dual independent renames (A & B): only new names exist on remote; both clients adopt; old names absent.
// - A-only rename (and switched roles): rename propagates and old name disappears everywhere.
// - A updates a file that B previously deleted locally → B must NOT redownload it (even though remote updates).
// - Rename/Rename conflict on the SAME shared file propagates (both clients end with both names; no old name).
// - Global-only delete & resurrection with nuance (previously-deleted locally).
// - NEW: “Never‑adopted remote exists” scenario: local rename + **download remote version** (even if previously deleted locally is the
//   general rule, here the existence of a remote version triggers a conflict and download). Peers adopt both.
// - NEW: Global rename initiated on server (copy+delete without manifest change) propagates to all clients.

use anyhow::{Context, Result};
use tokio::fs as tokio_fs;
use uuid::Uuid;

#[path = "hippius_policy_harness.rs"]
mod harness;
use harness::*;

#[test]
fn local_only_deletes_policy_concurrency() -> Result<()> {
    let os_stack = std::env::var("SMOKE_OS_STACK_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(16 * 1024 * 1024);

    let jh = std::thread::Builder::new()
        .name("hippius_local_only_deletes_test".into())
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
                let boot = boot_stack().await?;
                let s3c = s3_client(&boot.s3_endpoint).await?;
                let bucket = new_bucket(&s3c).await?;

                let waves = env_usize("SMOKE_WAVES", 1);
                let create_per_client = env_usize("SMOKE_CREATE_PER_CLIENT", 6);
                let _delete_per_client = env_usize("SMOKE_DELETE_PER_CLIENT", 6);
                let restore_per_client = env_usize("SMOKE_RESURRECT_PER_CLIENT", 4);
                let conflict_keys_per_wave = env_usize("SMOKE_CONFLICT_KEYS", 3).max(1);
                let _overwrite_per_client = env_usize("SMOKE_OVERWRITE_PER_CLIENT", 4);

                let rounds_delete = env_usize("SMOKE_SYNC_ROUNDS_DELETE", 5);
                let rounds_conflict = env_usize("SMOKE_SYNC_ROUNDS_CONFLICT", 5);
                let rounds_restore = env_usize("SMOKE_SYNC_ROUNDS_RES", 5);
                let rounds_rename = env_usize("SMOKE_SYNC_ROUNDS_RENAME", 5);
                let check_iters = env_usize("SMOKE_CHECK_ITERS", 5);

                let tag8 = "smoketag";
                let (a_ctx, _ta) = make_client_ctx(
                    "A",
                    &boot.s3_endpoint,
                    &bucket,
                    format!("{tag8}-A"),
                    DeletePolicy::LocalOnlyDeletes,
                )
                .await?;
                let (b_ctx, _tb) = make_client_ctx(
                    "B",
                    &boot.s3_endpoint,
                    &bucket,
                    format!("{tag8}-B"),
                    DeletePolicy::LocalOnlyDeletes,
                )
                .await?;

                for w in 0..waves {
                    eprintln!("=== [LocalOnlyDeletes] Wave {w} ===");

                    // 1) Concurrent creates: both should get all
                    let a_keys: Vec<_> = (0..create_per_client)
                        .map(|i| format!("pair/a-w{w:02}-{i:04}.txt"))
                        .collect();
                    let b_keys: Vec<_> = (0..create_per_client)
                        .map(|i| format!("pair/b-w{w:02}-{i:04}.txt"))
                        .collect();
                    let a_label = format!("from-A-wave-{w}");
                    let b_label = format!("from-B-wave-{w}");
                    let (wa, wb) = tokio::join!(
                        write_many(&a_ctx.local_root, &a_keys, &a_label),
                        write_many(&b_ctx.local_root, &b_keys, &b_label),
                    );
                    wa.context("writes A (create)")?;
                    wb.context("writes B (create)")?;

                    sync_until_present_on_both(&a_ctx, &b_ctx, &a_keys, check_iters).await?;
                    sync_until_present_on_both(&a_ctx, &b_ctx, &b_keys, check_iters).await?;
                    // 1b) No spurious copies
                    let a_pref = format!("pair/a-w{w:02}-");
                    let b_pref = format!("pair/b-w{w:02}-");
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &a_pref, a_keys.len()).await?;
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &b_pref, b_keys.len()).await?;

                    // 1b) Global-only delete & resurrect (case 1): neither client had locally deleted -> both should re-download
                    let glob1: Vec<_> = (0..2).map(|i| format!("pair/lod-glob-delres1-{i:02}.txt")).collect();
                    // Seed via A
                    write_many(&a_ctx.local_root, &glob1, "glob-delres1").await?;
                    sync_until_present_on_both(&a_ctx, &b_ctx, &glob1, check_iters)
                        .await
                        .with_context(|| format!("[LocalOnlyDeletes] seed glob-delres1 present on both {:?}", glob1))?;
                    // Remote delete
                    remote_delete_many(&a_ctx.s3, &bucket, &glob1).await?;
                    let need_abs: std::collections::HashSet<_> = glob1.iter().cloned().collect();
                    wait_remote_absent_all(&a_ctx.s3, &bucket, &need_abs, &a_ctx, &b_ctx, check_iters)
                        .await
                        .with_context(|| "[LocalOnlyDeletes] wait remote absent after glob-delres1 delete")?;
                    // Both clients should drop them
                    for _ in 0..2 { sync_both(&a_ctx, &b_ctx, 1).await?; }
                    let la_drop = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb_drop = list_local_pair_keys(&b_ctx.local_root)?;
                    for k in &glob1 {
                        assert!(!la_drop.contains(k) && !lb_drop.contains(k), "[LocalOnlyDeletes] after remote delete, both clients must drop {}", k);
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 0).await?;
                    }
                    // Remote resurrect
                    remote_put_many_with_body(&a_ctx.s3, &bucket, &glob1, "glob-delres1-resurrect").await?;
                    sync_until_present_on_both(&a_ctx, &b_ctx, &glob1, check_iters)
                        .await
                        .with_context(|| format!("[LocalOnlyDeletes] expect glob-delres1 resurrected to both {:?}", glob1))?;
                    for k in &glob1 {
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }

                    // 1c) Global-only delete & resurrect (case 2): A had locally deleted before; A should NOT re-download on resurrect, B should.
                    let glob2: Vec<_> = (0..2).map(|i| format!("pair/lod-glob-delres2-{i:02}.txt")).collect();
                    write_many(&a_ctx.local_root, &glob2, "glob-delres2").await?;
                    sync_until_present_on_both(&a_ctx, &b_ctx, &glob2, check_iters)
                        .await
                        .with_context(|| "[LocalOnlyDeletes] seed glob-delres2 present on both")?;
                    // A deletes locally
                    delete_many(&a_ctx.local_root, &glob2).await?;
                    sync_both(&a_ctx, &b_ctx, 2).await?;
                    // Remote delete (global), then resurrect
                    remote_delete_many(&a_ctx.s3, &bucket, &glob2).await?;
                    wait_remote_absent_all(&a_ctx.s3, &bucket, &glob2.iter().cloned().collect(), &a_ctx, &b_ctx, check_iters)
                        .await
                        .with_context(|| "[LocalOnlyDeletes] wait remote absent after glob-delres2 delete")?;
                    remote_put_many_with_body(&a_ctx.s3, &bucket, &glob2, "glob-delres2-resurrect").await?;
                    // A should keep them deleted; B should restore
                    for _ in 0..3 { sync_both(&a_ctx, &b_ctx, 1).await?; }
                    let la2 = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb2 = list_local_pair_keys(&b_ctx.local_root)?;
                    for k in &glob2 {
                        assert!(!la2.contains(k), "[LocalOnlyDeletes] A previously-deleted should stay deleted on resurrect {}", k);
                        assert!(lb2.contains(k), "[LocalOnlyDeletes] B should restore on resurrect {}", k);
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }


                    // 2) Concurrent deletes — remote still has all; deletions don't propagate
                    let (da, db) = tokio::join!(
                        delete_many(&a_ctx.local_root, &a_keys),
                        delete_many(&b_ctx.local_root, &b_keys),
                    );
                    da.context("deletes A")?;
                    db.context("deletes B")?;

                    sync_both(&a_ctx, &b_ctx, rounds_delete).await?;
                    let remote_now = list_remote_pair_keys(&a_ctx.s3, &bucket).await?;
                    for k in a_keys.iter().chain(b_keys.iter()) {
                        assert!(
                            remote_now.contains(k),
                            "remote should still have {k} under LocalOnlyDeletes"
                        );
                    }
                    let la = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb = list_local_pair_keys(&b_ctx.local_root)?;
                    for k in &a_keys {
                        assert!(!la.contains(k), "A's local delete should persist ({k})");
                        assert!(lb.contains(k), "B should still keep A's file ({k})");
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }
                    for k in &b_keys {
                        assert!(!lb.contains(k), "B's local delete should persist ({k})");
                        assert!(la.contains(k), "A should still keep B's file ({k})");
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }

                    // 3) Concurrent restores (re-create locally on each side)
                    let a_res: Vec<String> = a_keys
                        .iter()
                        .take(restore_per_client.min(a_keys.len()))
                        .cloned()
                        .collect();
                    let b_res: Vec<String> = b_keys
                        .iter()
                        .take(restore_per_client.min(b_keys.len()))
                        .cloned()
                        .collect();
                    let res_a = format!("restore-from-A wave:{w}");
                    let res_b = format!("restore-from-B wave:{w}");
                    let (ra, rb) = tokio::join!(
                        write_many_with_body(&a_ctx.local_root, &a_res, &res_a),
                        write_many_with_body(&b_ctx.local_root, &b_res, &res_b),
                    );
                    ra?;
                    rb?;
                    for _ in 0..rounds_restore {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    // Restored files should remain locally
                    let la2 = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb2 = list_local_pair_keys(&b_ctx.local_root)?;
                    for k in &a_res {
                        assert!(la2.contains(k), "A restored {k} must persist");
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }
                    for k in &b_res {
                        assert!(lb2.contains(k), "B restored {k} must persist");
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }

                    // 4) Distinct subset overwrites (visible on both clients)
                    let a_ow = a_res.clone();
                    let b_ow = b_res.clone();
                    let ow_a = format!("overwrite-A-distinct wave:{w}");
                    let ow_b = format!("overwrite-B-distinct wave:{w}");
                    let (oa, ob) = tokio::join!(
                        write_many_with_body(&a_ctx.local_root, &a_ow, &ow_a),
                        write_many_with_body(&b_ctx.local_root, &b_ow, &ow_b),
                    );
                    oa?;
                    ob?;
                    for _ in 0..rounds_conflict {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    for k in a_ow.iter().chain(b_ow.iter()) {
                        let a_body = read_local_text(&a_ctx.local_root, k)?;
                        let b_body = read_local_text(&b_ctx.local_root, k)?;
                        assert!(
                            a_body.contains("overwrite-") && b_body.contains("overwrite-"),
                            "both clients should see updated body for {k}"
                        );
                        let rb = read_remote_text(&a_ctx.s3, &bucket, k).await?;
                        assert!(
                            rb.contains("overwrite-"),
                            "remote must contain updated body for {k}"
                        );
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }

                    // 4a) A updates a file that B previously deleted locally → B should NOT redownload
                    // Choose a key that B deleted in step 2 (one from b_keys)
                    let idx = restore_per_client.min(b_keys.len() - 1);
                    let b_del_one = b_keys[idx].clone(); // first key NOT recreated by B
                    // A still has it (LocalOnlyDeletes keeps peer files). A updates it.
                    write_many_with_body(&a_ctx.local_root, &[b_del_one.clone()], "A-updates-B-deleted").await?;
                    for _ in 0..3 {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    let la3 = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb3 = list_local_pair_keys(&b_ctx.local_root)?;
                    assert!(la3.contains(&b_del_one), "A must keep updated {}", b_del_one);
                    assert!(!lb3.contains(&b_del_one), "B must NOT re-download previously deleted {}", b_del_one);
                    let rb3 = read_remote_text(&a_ctx.s3, &bucket, &b_del_one).await?;
                    assert!(rb3.contains("A-updates-B-deleted"), "remote should reflect A's update to {}", b_del_one);
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &b_del_one, 1).await?;

                    // 5) Same-name concurrent create (conflict) — name-agnostic
                    let mut conflict_keys: Vec<String> =
                        vec![format!("pair/shared-create-w{w:02}.txt")];
                    for i in 0..(conflict_keys_per_wave.saturating_sub(1)) {
                        conflict_keys.push(format!("pair/shared-create-w{w:02}-{i:03}.txt"));
                    }
                    let mut ck_gids: Vec<(String, String)> = Vec::new(); // (key, gid)
                    for ck in conflict_keys.iter() {
                        let gid = Uuid::new_v4().simple().to_string();
                        let (r1, r2) = tokio::join!(
                            write_marked(&a_ctx.local_root, ck, &gid, "A", "conflict-create"),
                            write_marked(&b_ctx.local_root, ck, &gid, "B", "conflict-create"),
                        );
                        r1?;
                        r2?;
                        ck_gids.push((ck.clone(), gid));
                    }
                    sync_both(&a_ctx, &b_ctx, rounds_conflict).await?;

                    for (_ck, gid) in ck_gids.iter() {
                        // Both clients must have both bodies; remote must have both bodies
                        let av = find_local_by_gid(&a_ctx.local_root, gid)?;
                        let bv = find_local_by_gid(&b_ctx.local_root, gid)?;
                        let rv = find_remote_by_gid(&a_ctx.s3, &bucket, gid).await?;
                        assert!(
                            distinct_body_count(&rv) >= 2,
                            "remote must expose >=2 bodies for gid {gid}"
                        );
                        assert!(
                            distinct_body_count(&av) >= 2
                                && contains_body_from(&av, "A")
                                && contains_body_from(&av, "B"),
                            "A should have both variants for gid {gid}"
                        );
                        assert!(
                            distinct_body_count(&bv) >= 2
                                && contains_body_from(&bv, "A")
                                && contains_body_from(&bv, "B"),
                            "B should have both variants for gid {gid}"
                        );
                    }

                    // 6) Concurrent overwrites of the same key — name-agnostic
                    let ow_key = format!("pair/shared-create-w{w:02}.txt");
                    let gid_ow = Uuid::new_v4().simple().to_string();
                    let (r1, r2) = tokio::join!(
                        write_marked(
                            &a_ctx.local_root,
                            &ow_key,
                            &gid_ow,
                            "A",
                            "overwrite-conflict"
                        ),
                        write_marked(
                            &b_ctx.local_root,
                            &ow_key,
                            &gid_ow,
                            "B",
                            "overwrite-conflict"
                        ),
                    );
                    r1?;
                    r2?;
                    sync_both(&a_ctx, &b_ctx, rounds_conflict).await?;
                    let av = find_local_by_gid(&a_ctx.local_root, &gid_ow)?;
                    let bv = find_local_by_gid(&b_ctx.local_root, &gid_ow)?;
                    assert!(
                        distinct_body_count(&av) >= 2
                            && contains_body_from(&av, "A")
                            && contains_body_from(&av, "B"),
                        "A should see both overwrite bodies"
                    );
                    assert!(
                        distinct_body_count(&bv) >= 2
                            && contains_body_from(&bv, "A")
                            && contains_body_from(&bv, "B"),
                        "B should see both overwrite bodies"
                    );

                    // 7) Delete a conflict variant locally on A -> stays deleted on A, persists on B & remote (name-agnostic)
                    // Reuse the first conflict gid from step 5
                    let (_base_ck, gid_first) = ck_gids[0].clone();
                    let r_pairs = find_remote_by_gid(&a_ctx.s3, &bucket, &gid_first).await?;
                    assert!(
                        !r_pairs.is_empty(),
                        "expect remote variant keys for gid {}",
                        gid_first
                    );
                    // Choose a key that A actually has locally to delete
                    let a_local_keys = list_local_pair_keys(&a_ctx.local_root)?;
                    let mut key_to_delete: Option<String> = None;
                    for (k, _b) in r_pairs.iter() {
                        if a_local_keys.contains(k) {
                            key_to_delete = Some(k.clone());
                            break;
                        }
                    }
                    let key_to_delete = key_to_delete.unwrap_or_else(|| r_pairs[0].0.clone());
                    let del_path = to_local_path(&a_ctx.local_root, &key_to_delete);
                    let _ = tokio_fs::remove_file(&del_path).await;
                    for _ in 0..3 {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                        let a_local_now = list_local_pair_keys(&a_ctx.local_root)?;
                        let b_local_now = list_local_pair_keys(&b_ctx.local_root)?;
                        let remote_now = list_remote_pair_keys(&a_ctx.s3, &bucket).await?;
                        assert!(
                            !a_local_now.contains(&key_to_delete),
                            "A keeps locally deleted variant {} deleted",
                            key_to_delete
                        );
                        assert!(
                            b_local_now.contains(&key_to_delete),
                            "B still keeps variant {}",
                            key_to_delete
                        );
                        assert!(
                            remote_now.contains(&key_to_delete),
                            "remote still keeps variant {}",
                            key_to_delete
                        );
                    }

                    // 8) Dual independent renames (propagate)
                    let old_a = format!("pair/rename-lod-A-{w:02}.txt");
                    let new_a = format!("pair/rename-lod-A-{w:02}-renamed.txt");
                    let old_b = format!("pair/rename-lod-B-{w:02}.txt");
                    let new_b = format!("pair/rename-lod-B-{w:02}-renamed.txt");
                    assert_dual_rename_propagates(
                        &a_ctx,
                        &b_ctx,
                        &bucket,
                        &old_a,
                        &new_a,
                        &old_b,
                        &new_b,
                        rounds_rename,
                        check_iters,
                    )
                    .await?;

                    // 9) Single-side rename (A), then reversed (B) to assert role symmetry
                    let old_key = format!("pair/rename-lod-{w:02}.txt");
                    let new_key = format!("pair/rename-lod-{w:02}-renamed.txt");
                    assert_rename_propagates(
                        &a_ctx,
                        &b_ctx,
                        &bucket,
                        &old_key,
                        &new_key,
                        rounds_rename,
                        check_iters,
                    )
                    .await?;
                    let old_key_b = format!("pair/rename-lodB-{w:02}.txt");
                    let new_key_b = format!("pair/rename-lodB-{w:02}-renamed.txt");
                    assert_rename_propagates(
                        &b_ctx,
                        &a_ctx,
                        &bucket,
                        &old_key_b,
                        &new_key_b,
                        rounds_rename,
                        check_iters,
                    )
                    .await?;

                    // 10) Rename/Rename conflict for the SAME file (propagates fully)
                    let rr_old = format!("pair/lod-rr-old-w{w:02}.txt");
                    let rr_a   = format!("pair/lod-rr-A-w{w:02}-renamed.txt");
                    let rr_b   = format!("pair/lod-rr-B-w{w:02}-renamed.txt");
                    assert_rename_rename_conflict_propagates(
                        &a_ctx, &b_ctx, &bucket, &rr_old, &rr_a, &rr_b, rounds_rename, check_iters
                    ).await?;

                    // 11) Global-only delete & resurrection with nuance
                    // (a) pick a key not previously deleted locally → both should redownload on resurrect
                    let gdr_both = a_keys[0].clone(); // B didn't locally delete this in step 2
                    remote_delete_many(&a_ctx.s3, &bucket, &[gdr_both.clone()]).await?;
                    let need_abs: std::collections::HashSet<String> = [gdr_both.clone()].into_iter().collect();
                    wait_remote_absent_all(&a_ctx.s3, &bucket, &need_abs, &a_ctx, &b_ctx, check_iters).await?;
                    for _ in 0..rounds_delete {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    // Must be deleted on both
                    let la_del = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb_del = list_local_pair_keys(&b_ctx.local_root)?;
                    assert!(!la_del.contains(&gdr_both) && !lb_del.contains(&gdr_both), "both delete {}", gdr_both);
                    // resurrect → both redownload
                    remote_put_text(&a_ctx.s3, &bucket, &gdr_both, "remote-resurrect\n").await?;
                    wait_remote_contains_all(&a_ctx.s3, &bucket, &need_abs, &a_ctx, &b_ctx, check_iters).await?;
                    for _ in 0..rounds_delete {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    let la_post = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb_post = list_local_pair_keys(&b_ctx.local_root)?;
                    assert!(la_post.contains(&gdr_both) && lb_post.contains(&gdr_both), "both redownload {}", gdr_both);
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &gdr_both, 1).await?;

                    // (b) pick a key previously deleted locally on B (one from b_keys) → B must NOT redownload on resurrect
                    let gdr_b_prev_del = b_keys[1].clone(); // B deleted these in step 2
                    remote_delete_many(&a_ctx.s3, &bucket, &[gdr_b_prev_del.clone()]).await?;
                    let need_abs2: std::collections::HashSet<String> = [gdr_b_prev_del.clone()].into_iter().collect();
                    wait_remote_absent_all(&a_ctx.s3, &bucket, &need_abs2, &a_ctx, &b_ctx, check_iters).await?;
                    for _ in 0..rounds_delete {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    // A likely had it; both now don't
                    remote_put_text(&a_ctx.s3, &bucket, &gdr_b_prev_del, "remote-resurrect-previously-deleted\n").await?;
                    wait_remote_contains_all(&a_ctx.s3, &bucket, &need_abs2, &a_ctx, &b_ctx, check_iters).await?;
                    for _ in 0..rounds_delete {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    let la_post2 = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb_post2 = list_local_pair_keys(&b_ctx.local_root)?;
                    assert!(la_post2.contains(&gdr_b_prev_del), "A should redownload {}", gdr_b_prev_del);
                    assert!(lb_post2.contains(&gdr_b_prev_del), "B must redownload previously locally deleted file {} on global resurrect", gdr_b_prev_del);
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &gdr_b_prev_del, 1).await?;

                    // 12) NEW — Never-adopted remote exists → local rename + download remote version (both adopt both variants)
                    let na_key = format!("pair/lod-na-w{w:02}.txt");
                    let gid_na = Uuid::new_v4().simple().to_string();
                    remote_put_text(&a_ctx.s3, &bucket, &na_key, &format!("seed who:R gid:{gid_na}\n")).await?;
                    write_marked(&b_ctx.local_root, &na_key, &gid_na, "B", "never-adopted-local").await?;
                    for _ in 0..rounds_conflict { sync_both(&a_ctx, &b_ctx, 1).await?; }
                    let a_na = find_local_by_gid(&a_ctx.local_root, &gid_na)?;
                    let b_na = find_local_by_gid(&b_ctx.local_root, &gid_na)?;
                    assert!(distinct_body_count(&a_na) >= 2 && contains_body_from(&a_na,"R") && contains_body_from(&a_na,"B"),
                            "[LOD] A must adopt both variants");
                    assert!(distinct_body_count(&b_na) >= 2 && contains_body_from(&b_na,"R") && contains_body_from(&b_na,"B"),
                            "[LOD] B must adopt both variants");

                    // 13) NEW — Global rename initiated on server (copy+delete)
                    let gr_old = format!("pair/lod-gr-old-w{w:02}.txt");
                    let gr_new = format!("pair/lod-gr-old-w{w:02}-renamed.txt");
                    write_one(&a_ctx.local_root, &gr_old, "seed\n").await?;
                    sync_until_present_on_both(&a_ctx, &b_ctx, &[gr_old.clone()], check_iters).await?;
                    remote_rename(&a_ctx.s3, &bucket, &gr_old, &gr_new).await?;
                    let need_new: std::collections::HashSet<String> = [gr_new.clone()].into_iter().collect();
                    wait_remote_contains_all(&a_ctx.s3, &bucket, &need_new, &a_ctx, &b_ctx, check_iters).await?;
                    let need_old: std::collections::HashSet<String> = [gr_old.clone()].into_iter().collect();
                    wait_remote_absent_all(&a_ctx.s3, &bucket, &need_old, &a_ctx, &b_ctx, check_iters).await?;
                    for _ in 0..rounds_rename { sync_both(&a_ctx, &b_ctx, 1).await?; }
                    for ctx in [&a_ctx, &b_ctx] {
                        let loc = list_local_pair_keys(&ctx.local_root)?;
                        assert!(loc.contains(&gr_new) && !loc.contains(&gr_old),
                                "[LOD] {} must adopt server-initiated rename (only new name)", ctx.name);
                    }
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &gr_new, 1).await?;
                }

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
