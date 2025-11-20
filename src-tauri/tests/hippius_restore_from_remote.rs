// tests/hippius_restore_from_remote.rs
//
// Policy: RestoreFromRemote
// Enforced behaviours (extended):
// - New files propagate to both clients.
// - Local deletes do NOT propagate; files are restored locally.
// - Distinct subset overwrites: latest bodies propagate to both clients and remote; **no extra copies** created.
// - Rename must propagate (no duplication) — both clients adopt; remote has only new names.
// - Dual independent renames (A & B) propagate concurrently.
// - Conflicts resolve with both variants present for both clients (both create & both overwrite).
// - Same-file Rename/Rename conflict propagates (remote only new names; both clients adopt both).
// - Global-only delete & resurrection: locals delete on global delete, redownload on resurrect.
// - NEW: “Never‑adopted remote exists” scenario: local rename + download remote version (both sides adopt both, since RFR always downloads).
// - NEW: Global rename initiated on server (copy+delete without manifest change) propagates to all clients as a rename.
use anyhow::{Context, Result};
use uuid::Uuid;

#[path = "hippius_policy_harness.rs"]
mod harness;
use harness::*;

#[test]
fn restore_from_remote_policy_concurrency() -> Result<()> {
    let os_stack = std::env::var("SMOKE_OS_STACK_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(16 * 1024 * 1024);

    let jh = std::thread::Builder::new()
        .name("hippius_restore_from_remote_test".into())
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
                let conflict_keys_per_wave = env_usize("SMOKE_CONFLICT_KEYS", 3).max(1);
                let overwrite_per_client = env_usize("SMOKE_OVERWRITE_PER_CLIENT", 4);

                let _rounds_create = env_usize("SMOKE_SYNC_ROUNDS_CREATE", 5);
                let _rounds_delete = env_usize("SMOKE_SYNC_ROUNDS_DELETE", 5);
                let rounds_conflict = env_usize("SMOKE_SYNC_ROUNDS_CONFLICT", 5);
                let rounds_rename = env_usize("SMOKE_SYNC_ROUNDS_RENAME", 5);
                let rounds_delete = env_usize("SMOKE_SYNC_ROUNDS_DELETE", 5);
                let check_iters = env_usize("SMOKE_CHECK_ITERS", 5);

                let tag8 = "smoketag";
                let (a_ctx, _ta) = make_client_ctx(
                    "A",
                    &boot.s3_endpoint,
                    &bucket,
                    format!("{tag8}-A"),
                    DeletePolicy::RestoreFromRemote,
                )
                .await?;
                let (b_ctx, _tb) = make_client_ctx(
                    "B",
                    &boot.s3_endpoint,
                    &bucket,
                    format!("{tag8}-B"),
                    DeletePolicy::RestoreFromRemote,
                )
                .await?;

                for w in 0..waves {
                    eprintln!("=== [RestoreFromRemote] Wave {w} ===");

                    // 1) Creates propagate to both
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

                    // 1b) No spurious copies for create prefixes
                    let a_pref = format!("pair/a-w{w:02}-");
                    let b_pref = format!("pair/b-w{w:02}-");
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &a_pref, a_keys.len())
                        .await?;
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &b_pref, b_keys.len())
                        .await?;

                    // 2) Local deletes restore from remote
                    let (da, db) = tokio::join!(
                        delete_many(&a_ctx.local_root, &a_keys),
                        delete_many(&b_ctx.local_root, &b_keys),
                    );
                    da?;
                    db?;
                    sync_until_present_on_both(&a_ctx, &b_ctx, &a_keys, check_iters).await?;
                    sync_until_present_on_both(&a_ctx, &b_ctx, &b_keys, check_iters).await?;

                    // 3) Distinct subset overwrites -> latest bodies propagate to both
                    let a_ow: Vec<String> = a_keys
                        .iter()
                        .take(overwrite_per_client.min(a_keys.len()))
                        .cloned()
                        .collect();
                    let b_ow: Vec<String> = b_keys
                        .iter()
                        .take(overwrite_per_client.min(b_keys.len()))
                        .cloned()
                        .collect();
                    let ow_a = format!("ow-distinct-A wave:{w}");
                    let ow_b = format!("ow-distinct-B wave:{w}");
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
                            a_body.contains("ow-distinct-") && b_body.contains("ow-distinct-"),
                            "both clients should observe updated body for {k}"
                        );
                        let rb = read_remote_text(&a_ctx.s3, &bucket, k).await?;
                        assert!(
                            rb.contains("ow-distinct-"),
                            "remote must contain updated body for {k}"
                        );
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }

                    // 4) Single-side rename propagation (+ symmetry)
                    let old_key = format!("pair/rename-rfr-{w:02}.txt");
                    let new_key = format!("pair/rename-rfr-{w:02}-renamed.txt");
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
                    let old_key_b = format!("pair/rename-rfrB-{w:02}.txt");
                    let new_key_b = format!("pair/rename-rfrB-{w:02}-renamed.txt");
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

                    // 5) Dual independent renames concurrently
                    let old_a = format!("pair/rename-rfr-A-{w:02}.txt");
                    let new_a = format!("pair/rename-rfr-A-{w:02}-renamed.txt");
                    let old_b = format!("pair/rename-rfr-B-{w:02}.txt");
                    let new_b = format!("pair/rename-rfr-B-{w:02}-renamed.txt");
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

                    // 5b) Same-file dual rename (A->new_a, B->new_b) propagates fully
                    let same_old = format!("pair/rename-rfr-same-{w:02}.txt");
                    let same_new_a = format!("pair/rename-rfr-same-{w:02}-A.txt");
                    let same_new_b = format!("pair/rename-rfr-same-{w:02}-B.txt");
                    assert_bi_rename_same_file_propagates(
                        &a_ctx,
                        &b_ctx,
                        &bucket,
                        &same_old,
                        &same_new_a,
                        &same_new_b,
                        rounds_rename,
                        check_iters,
                    )
                    .await?;

                    // 6) Same-name concurrent create (conflict) — name-agnostic
                    let mut conflict_keys: Vec<String> =
                        vec![format!("pair/shared-create-w{w:02}.txt")];
                    for i in 0..(conflict_keys_per_wave.saturating_sub(1)) {
                        conflict_keys.push(format!("pair/shared-create-w{w:02}-{i:03}.txt"));
                    }
                    let mut ck_gids: Vec<(String, String)> = Vec::new();
                    for ck in conflict_keys.iter() {
                        let gid = Uuid::new_v4().simple().to_string();
                        let (r1, r2) = tokio::join!(
                            write_marked(&a_ctx.local_root, ck, &gid, "A", "create-conflict"),
                            write_marked(&b_ctx.local_root, ck, &gid, "B", "create-conflict"),
                        );
                        r1?;
                        r2?;
                        ck_gids.push((ck.clone(), gid));
                    }
                    sync_both(&a_ctx, &b_ctx, rounds_conflict).await?;
                    for (_ck, gid) in ck_gids.iter() {
                        let rvars = find_remote_by_gid(&a_ctx.s3, &bucket, gid).await?;
                        assert!(
                            distinct_body_count(&rvars) >= 2,
                            "remote has >=2 bodies for gid {gid}"
                        );
                        let av = find_local_by_gid(&a_ctx.local_root, gid)?;
                        let bv = find_local_by_gid(&b_ctx.local_root, gid)?;
                        assert!(
                            distinct_body_count(&av) >= 2
                                && contains_body_from(&av, "A")
                                && contains_body_from(&av, "B"),
                            "A should see both bodies after conflict"
                        );
                        assert!(
                            distinct_body_count(&bv) >= 2
                                && contains_body_from(&bv, "A")
                                && contains_body_from(&bv, "B"),
                            "B should see both bodies after conflict"
                        );
                    }

                    // 7) Concurrent overwrites of the same key -> both variants present for both clients — name-agnostic
                    let ow_key = format!("pair/shared-overwrite-w{w:02}.txt");
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

                    // 8) Same-file Rename/Rename conflict (propagates fully)
                    let rr_old = format!("pair/rfr-rr-old-w{w:02}.txt");
                    let rr_a = format!("pair/rfr-rr-A-w{w:02}-renamed.txt");
                    let rr_b = format!("pair/rfr-rr-B-w{w:02}-renamed.txt");
                    assert_rename_rename_conflict_propagates(
                        &a_ctx,
                        &b_ctx,
                        &bucket,
                        &rr_old,
                        &rr_a,
                        &rr_b,
                        rounds_rename,
                        check_iters,
                    )
                    .await?;

                    // 9) Global-only delete & resurrection
                    // pick one from A and one from B (both are present on both clients under RFR)
                    let del_a = a_keys[0].clone();
                    let del_b = b_keys[0].clone();
                    remote_delete_many(&a_ctx.s3, &bucket, &[del_a.clone(), del_b.clone()]).await?;
                    let need_abs: std::collections::HashSet<String> =
                        [del_a.clone(), del_b.clone()].into_iter().collect();
                    wait_remote_absent_all(
                        &a_ctx.s3,
                        &bucket,
                        &need_abs,
                        &a_ctx,
                        &b_ctx,
                        check_iters,
                    )
                    .await?;
                    for _ in 0..rounds_delete {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    for k in [&del_a, &del_b] {
                        let la = list_local_pair_keys(&a_ctx.local_root)?;
                        let lb = list_local_pair_keys(&b_ctx.local_root)?;
                        assert!(
                            !la.contains(k) && !lb.contains(k),
                            "both clients must delete {} after global delete",
                            k
                        );
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 0).await?;
                    }
                    // resurrect remotely → both clients redownload
                    remote_put_text(&a_ctx.s3, &bucket, &del_a, "remote-resurrect-A\n").await?;
                    remote_put_text(&a_ctx.s3, &bucket, &del_b, "remote-resurrect-B\n").await?;
                    let need_present: std::collections::HashSet<String> =
                        [del_a.clone(), del_b.clone()].into_iter().collect();
                    wait_remote_contains_all(
                        &a_ctx.s3,
                        &bucket,
                        &need_present,
                        &a_ctx,
                        &b_ctx,
                        check_iters,
                    )
                    .await?;
                    for _ in 0..rounds_delete {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    for k in [&del_a, &del_b] {
                        let la = list_local_pair_keys(&a_ctx.local_root)?;
                        let lb = list_local_pair_keys(&b_ctx.local_root)?;
                        assert!(
                            la.contains(k) && lb.contains(k),
                            "both clients must redownload resurrected {}",
                            k
                        );
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }

                    // 10) NEW — Never-adopted remote exists → local rename + download remote version (both clients end with both variants)
                    let na_key = format!("pair/rfr-na-w{w:02}.txt");
                    let gid_na = Uuid::new_v4().simple().to_string();
                    remote_put_text(&a_ctx.s3, &bucket, &na_key, &format!("seed who:R gid:{gid_na}\n")).await?;
                    // B writes locally to same path before adopting
                    write_marked(&b_ctx.local_root, &na_key, &gid_na, "B", "never-adopted-local").await?;
                    for _ in 0..rounds_conflict { sync_both(&a_ctx, &b_ctx, 1).await?; }
                    let rv_na = find_remote_by_gid(&a_ctx.s3, &bucket, &gid_na).await?;
                    assert!(distinct_body_count(&rv_na) >= 2, "remote must expose both bodies in never-adopted");
                    let a_na = find_local_by_gid(&a_ctx.local_root, &gid_na)?;
                    let b_na = find_local_by_gid(&b_ctx.local_root, &gid_na)?;
                    assert!(distinct_body_count(&a_na) >= 2 && contains_body_from(&a_na,"R") && contains_body_from(&a_na,"B"),
                            "[RFR] A must adopt both variants");
                    assert!(distinct_body_count(&b_na) >= 2 && contains_body_from(&b_na,"R") && contains_body_from(&b_na,"B"),
                            "[RFR] B must adopt both variants");

                    // 11) NEW — Global rename initiated on server (copy+delete)
                    let gr_old = format!("pair/rfr-gr-old-w{w:02}.txt");
                    let gr_new = format!("pair/rfr-gr-old-w{w:02}-renamed.txt");
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
                                "[RFR] {} must adopt server-initiated rename (only new name)", ctx.name);
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
