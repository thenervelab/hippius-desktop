// tests/hippius_mirror_local_deletes.rs
//
// Policy: MirrorLocalDeletes
// Multi-wave, randomized concurrency test (extended) with:
// - Concurrent creates (both get all) — **no extra copies** created for wave prefixes.
// - Concurrent deletes (global) with disjoint subsets.
// - Concurrent resurrections (global) with disjoint subsets.
// - Distinct subset overwrites (no conflict) — latest bodies seen on both and remote; **no extra copies** created.
// - Concurrent conflicting overwrites (same keys) — both variants present.
// - Dual independent renames concurrently (propagate; no duplication).
// - Single-side rename assertion (A then B) for symmetry.
// - Same-file Rename/Rename conflict propagates fully.
// - Global-only delete & resurrection: locals delete on global delete; redownload on resurrect.
// - NEW: “Never‑adopted remote exists” scenario: local rename + both variants adopted by all peers.
// - NEW: Global rename initiated on server (copy+delete without manifest change) propagates to all clients.

use anyhow::{Context, Result};
use std::collections::HashSet;
use uuid::Uuid;

#[path = "hippius_policy_harness.rs"]
mod harness;
use harness::*;

/* ----------------- Tiny RNG ----------------- */
#[derive(Clone)]
struct Lcg(u64);
impl Lcg {
    fn new(seed: u64) -> Self {
        Self(seed)
    }
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
        self.0
    }
    fn gen_range(&mut self, upper: usize) -> usize {
        if upper == 0 {
            0
        } else {
            ((self.next() >> 1) as usize) % upper
        }
    }
    fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            let j = self.gen_range(i + 1);
            v.swap(i, j);
        }
    }
}

#[test]
fn mirror_local_deletes_extended_concurrency() -> Result<()> {
    let os_stack = std::env::var("SMOKE_OS_STACK_BYTES")
        .ok().and_then(|v| v.parse().ok())
        .unwrap_or(16 * 1024 * 1024);

    let jh = std::thread::Builder::new()
        .name("hippius_mirror_local_deletes_test".into())
        .stack_size(os_stack)
        .spawn(|| -> Result<()> {
            let worker_threads = std::env::var("SMOKE_WORKER_THREADS")
                .ok().and_then(|v| v.parse().ok())
                .unwrap_or(4);
            let worker_stack = std::env::var("SMOKE_STACK_BYTES")
                .ok().and_then(|v| v.parse().ok())
                .unwrap_or(8 * 1024 * 1024);

            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(worker_threads)
                .thread_stack_size(worker_stack)
                .enable_all()
                .build()
                .expect("tokio runtime");

            rt.block_on(async {
                // ---- Controls ----
                let waves                 = env_usize("SMOKE_WAVES", 1);
                let create_per_client     = env_usize("SMOKE_CREATE_PER_CLIENT", 6);
                let delete_per_client     = env_usize("SMOKE_DELETE_PER_CLIENT", 4);
                let resurrect_per_client  = env_usize("SMOKE_RESURRECT_PER_CLIENT", 3);
                let conflict_keys_per_wave= env_usize("SMOKE_CONFLICT_KEYS", 3).max(1);
                let overwrite_per_client  = env_usize("SMOKE_OVERWRITE_PER_CLIENT", 3);

                let _rounds_create        = env_usize("SMOKE_SYNC_ROUNDS_CREATE", 5);
                let _rounds_delete        = env_usize("SMOKE_SYNC_ROUNDS_DELETE", 5);
                let rounds_res            = env_usize("SMOKE_SYNC_ROUNDS_RES", 5);
                let rounds_conflict       = env_usize("SMOKE_SYNC_ROUNDS_CONFLICT", 5);
                let rounds_rename         = env_usize("SMOKE_SYNC_ROUNDS_RENAME", 5);
                let rounds_delete_g       = env_usize("SMOKE_SYNC_ROUNDS_DELETE", 5);
                let check_iters           = env_usize("SMOKE_CHECK_ITERS", 5);

                let seed = match std::env::var("SMOKE_SEED").ok().and_then(|s| s.parse::<u64>().ok()) {
                    Some(s) => s,
                    None => std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH).unwrap()
                        .as_nanos() as u64,
                };
                eprintln!(
                    "[controls] waves={waves} create={create_per_client} delete={delete_per_client} \
                     resurrect={resurrect_per_client} conflict_keys={conflict_keys_per_wave} overwrite={overwrite_per_client} seed={seed}"
                );

                // ---- Boot stack & bucket ----
                let boot  = boot_stack().await?;
                let s3c   = s3_client(&boot.s3_endpoint).await?;
                let bucket= new_bucket(&s3c).await?;

                // ---- Two clients with SAME 8-char prunefile prefix ----
                let tag8 = "smoketag";
                let (a_ctx, _ta) = make_client_ctx(
                    "A", &boot.s3_endpoint, &bucket, format!("{tag8}-A"), DeletePolicy::MirrorLocalDeletes
                ).await?;
                let (b_ctx, _tb) = make_client_ctx(
                    "B", &boot.s3_endpoint, &bucket, format!("{tag8}-B"), DeletePolicy::MirrorLocalDeletes
                ).await?;

                // Mutable state
                let mut existing: HashSet<String>    = HashSet::new();
                let mut deleted_pool: HashSet<String> = HashSet::new();

                // ---- Waves ----
                for w in 0..waves {
                    eprintln!("=== [MirrorLocalDeletes] Wave {w} ===");

                    // 1) Concurrent creates
                    let a_keys: Vec<_> = (0..create_per_client).map(|i| format!("pair/a-w{w:02}-{i:04}.txt")).collect();
                    let b_keys: Vec<_> = (0..create_per_client).map(|i| format!("pair/b-w{w:02}-{i:04}.txt")).collect();

                    let a_label = format!("from-A-wave-{w}");
                    let b_label = format!("from-B-wave-{w}");
                    let (wa, wb) = tokio::join!(
                        write_many(&a_ctx.local_root, &a_keys, &a_label),
                        write_many(&b_ctx.local_root, &b_keys, &b_label),
                    );
                    wa.context("writes A (create)")?;
                    wb.context("writes B (create)")?;

                    // Ensure both clients see all creations
                    sync_until_present_on_both(&a_ctx, &b_ctx, &a_keys, check_iters).await?;
                    sync_until_present_on_both(&a_ctx, &b_ctx, &b_keys, check_iters).await?;
                    existing.extend(a_keys.clone());
                    existing.extend(b_keys.clone());

                    // 1b) No spurious copies for wave prefixes
                    let a_pref = format!("pair/a-w{w:02}-");
                    let b_pref = format!("pair/b-w{w:02}-");
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &a_pref, a_keys.len()).await?;
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &b_pref, b_keys.len()).await?;

                    // 2) Concurrent deletes — choose disjoint subsets randomly
                    let mut pool: Vec<String> = existing.iter().cloned().collect();
                    Lcg::new(seed ^ (w as u64)).shuffle(&mut pool);
                    let a_del = pool.iter().take(delete_per_client.min(pool.len())).cloned().collect::<Vec<_>>();
                    let rest: Vec<String> = pool.into_iter().filter(|k| !a_del.contains(k)).collect();
                    let b_del = rest.iter().take(delete_per_client.min(rest.len())).cloned().collect::<Vec<_>>();

                    let (da, db) = tokio::join!(
                        delete_many(&a_ctx.local_root, &a_del),
                        delete_many(&b_ctx.local_root, &b_del),
                    );
                    da.context("deletes A")?;
                    db.context("deletes B")?;

                    // Deletions propagate globally; verify and ensure stability (no peer restores)
                    sync_until_absent_on_both(&a_ctx, &b_ctx, &a_del, &b_del, check_iters).await?;
                    for _ in 0..3 {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                        let a_local_now = list_local_pair_keys(&a_ctx.local_root)?;
                        let b_local_now = list_local_pair_keys(&b_ctx.local_root)?;
                        let remote_now  = list_remote_pair_keys(&a_ctx.s3, &bucket).await?;
                        for k in a_del.iter().chain(b_del.iter()) {
                            assert!(!a_local_now.contains(k), "A should keep {k} deleted (no peer restore)");
                            assert!(!b_local_now.contains(k), "B should keep {k} deleted (no peer restore)");
                            assert!(!remote_now.contains(k),  "remote should keep {k} deleted");
                        }
                    }

                    for k in a_del.iter().chain(b_del.iter()) {
                        existing.remove(k);
                        deleted_pool.insert(k.clone());
                    }

                    // 3) Concurrent resurrections — choose disjoint subsets from deleted_pool
                    let mut dpool: Vec<String> = deleted_pool.iter().cloned().collect();
                    Lcg::new(seed ^ 0x9E3779B97F4A7C15 ^ (w as u64)).shuffle(&mut dpool);
                    let a_res = dpool.iter().take(resurrect_per_client.min(dpool.len())).cloned().collect::<Vec<_>>();
                    let drest: Vec<String> = dpool.into_iter().filter(|k| !a_res.contains(k)).collect();
                    let b_res = drest.iter().take(resurrect_per_client.min(drest.len())).cloned().collect::<Vec<_>>();

                    let res_a = format!("resurrect-from-A wave:{w}");
                    let res_b = format!("resurrect-from-B wave:{w}");
                    let (ra, rb) = tokio::join!(
                        write_many_with_body(&a_ctx.local_root, &a_res, &res_a),
                        write_many_with_body(&b_ctx.local_root, &b_res, &res_b),
                    );
                    ra.context("resurrects A")?;
                    rb.context("resurrects B")?;

                    // Ensure resurrections visible and stable (no instant re-delete)
                    sync_both(&a_ctx, &b_ctx, rounds_res).await?;
                    sync_until_present_on_both(&a_ctx, &b_ctx, &a_res, check_iters).await?;
                    sync_until_present_on_both(&a_ctx, &b_ctx, &b_res, check_iters).await?;
                    for _ in 0..3 {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                        let a_local_now = list_local_pair_keys(&a_ctx.local_root)?;
                        let b_local_now = list_local_pair_keys(&b_ctx.local_root)?;
                        let remote_now  = list_remote_pair_keys(&a_ctx.s3, &bucket).await?;
                        for k in a_res.iter().chain(b_res.iter()) {
                            assert!(a_local_now.contains(k), "A should still have resurrected {k}");
                            assert!(b_local_now.contains(k), "B should still have resurrected {k}");
                            assert!(remote_now.contains(k),  "remote should still have resurrected {k}");
                        }
                    }

                    for k in a_res.iter().chain(b_res.iter()) {
                        deleted_pool.remove(k);
                        existing.insert(k.clone());
                    }

                    // 4) Distinct subset overwrites (no conflict)
                    let mut ex_list: Vec<String> = existing.iter().cloned().collect();
                    Lcg::new(seed ^ 0xA5A5A5A5 ^ (w as u64)).shuffle(&mut ex_list);
                    let a_ow = ex_list.iter().take(overwrite_per_client.min(ex_list.len())).cloned().collect::<Vec<_>>();
                    let rest_ow: Vec<String> = ex_list.into_iter().filter(|k| !a_ow.contains(k)).collect();
                    let b_ow = rest_ow.iter().take(overwrite_per_client.min(rest_ow.len())).cloned().collect::<Vec<_>>();

                    let ow_a = format!("ow-distinct-A wave:{w}");
                    let ow_b = format!("ow-distinct-B wave:{w}");
                    let (oa, ob) = tokio::join!(
                        write_many_with_body(&a_ctx.local_root, &a_ow, &ow_a),
                        write_many_with_body(&b_ctx.local_root, &b_ow, &ow_b),
                    );
                    oa?; ob?;
                    sync_both(&a_ctx, &b_ctx, rounds_conflict).await?;
                    for k in a_ow.iter().chain(b_ow.iter()) {
                        let a_body = read_local_text(&a_ctx.local_root, k)?;
                        let b_body = read_local_text(&b_ctx.local_root, k)?;
                        assert!(a_body.contains("ow-distinct-") && b_body.contains("ow-distinct-"),
                                "both clients must observe updated body for {k}");
                        let rb = read_remote_text(&a_ctx.s3, &bucket, k).await?;
                        assert!(rb.contains("ow-distinct-"), "remote must contain updated body for {k}");
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }

                    // 5) Concurrent conflicting overwrites — name-agnostic
                    let mut conflict_keys: Vec<String> = vec!["pair/shared.txt".to_string()];
                    for i in 0..(conflict_keys_per_wave.saturating_sub(1)) {
                        conflict_keys.push(format!("pair/shared-w{w:02}-{i:03}.txt"));
                    }

                    let mut ck_gids: Vec<(String, String)> = Vec::new();
                    for ck in conflict_keys.iter() {
                        let gid = Uuid::new_v4().simple().to_string();
                        let (wsa, wsb) = tokio::join!(
                            write_marked(&a_ctx.local_root, ck, &gid, "A", "conflict-edit"),
                            write_marked(&b_ctx.local_root, ck, &gid, "B", "conflict-edit"),
                        );
                        wsa.with_context(|| format!("write shared A ({ck})"))?;
                        wsb.with_context(|| format!("write shared B ({ck})"))?;
                        ck_gids.push((ck.clone(), gid));
                    }

                    sync_both(&a_ctx, &b_ctx, rounds_conflict).await?;

                    // Verify conflicts: >=2 variants & both bodies present per client
                    for (_ck, gid) in ck_gids.iter() {
                        let a_shared = find_local_by_gid(&a_ctx.local_root, gid)?;
                        let b_shared = find_local_by_gid(&b_ctx.local_root, gid)?;
                        assert!(
                            distinct_body_count(&a_shared) >= 2
                                && contains_body_from(&a_shared, "A")
                                && contains_body_from(&a_shared, "B"),
                            "Client A should contain both conflict edits (gid {gid})"
                        );
                        assert!(
                            distinct_body_count(&b_shared) >= 2
                                && contains_body_from(&b_shared, "A")
                                && contains_body_from(&b_shared, "B"),
                            "Client B should contain both conflict edits (gid {gid})"
                        );
                    }

                    // 6) Dual independent renames (propagate) and single-side symmetry
                    let old_a = format!("pair/rename-ml-A-{w:02}.txt");
                    let new_a = format!("pair/rename-ml-A-{w:02}-renamed.txt");
                    let old_b = format!("pair/rename-ml-B-{w:02}.txt");
                    let new_b = format!("pair/rename-ml-B-{w:02}-renamed.txt");
                    assert_dual_rename_propagates(
                        &a_ctx, &b_ctx, &bucket, &old_a, &new_a, &old_b, &new_b, rounds_rename, check_iters
                    ).await?;

                    let old_key = format!("pair/rename-ml-{w:02}.txt");
                    let new_key = format!("pair/rename-ml-{w:02}-renamed.txt");
                    assert_rename_propagates(&a_ctx, &b_ctx, &bucket, &old_key, &new_key, rounds_rename, check_iters).await?;
                    let old_key_b = format!("pair/rename-mlB-{w:02}.txt");
                    let new_key_b = format!("pair/rename-mlB-{w:02}-renamed.txt");
                    assert_rename_propagates(&b_ctx, &a_ctx, &bucket, &old_key_b, &new_key_b, rounds_rename, check_iters).await?;

                    // 6b) Same-file dual rename (A->new_a, B->new_b) propagates fully
                    let same_old = format!("pair/rename-ml-same-{w:02}.txt");
                    let same_new_a = format!("pair/rename-ml-same-{w:02}-A.txt");
                    let same_new_b = format!("pair/rename-ml-same-{w:02}-B.txt");
                    assert_bi_rename_same_file_propagates(
                        &a_ctx, &b_ctx, &bucket, &same_old, &same_new_a, &same_new_b, rounds_rename, check_iters
                    ).await?;


                    // 7) Rename/Rename conflict for the SAME file (propagates fully)
                    let rr_old = format!("pair/ml-rr-old-w{w:02}.txt");
                    let rr_a   = format!("pair/ml-rr-A-w{w:02}-renamed.txt");
                    let rr_b   = format!("pair/ml-rr-B-w{w:02}-renamed.txt");
                    assert_rename_rename_conflict_propagates(
                        &a_ctx, &b_ctx, &bucket, &rr_old, &rr_a, &rr_b, rounds_rename, check_iters
                    ).await?;

                    // 8) Global-only delete & resurrection
                    // Pick two existing keys (from earlier 'existing' set if any), or seed new ones
                    let pick_a = format!("pair/ml-gdr-A-{w:02}.txt");
                    let pick_b = format!("pair/ml-gdr-B-{w:02}.txt");
                    write_one(&a_ctx.local_root, &pick_a, "seed\n").await?;
                    write_one(&b_ctx.local_root, &pick_b, "seed\n").await?;
                    sync_until_present_on_both(&a_ctx, &b_ctx, &[pick_a.clone(), pick_b.clone()], check_iters).await?;

                    remote_delete_many(&a_ctx.s3, &bucket, &[pick_a.clone(), pick_b.clone()]).await?;
                    let need_abs: std::collections::HashSet<String> =
                        [pick_a.clone(), pick_b.clone()].into_iter().collect();
                    wait_remote_absent_all(&a_ctx.s3, &bucket, &need_abs, &a_ctx, &b_ctx, check_iters).await?;
                    for _ in 0..rounds_delete_g {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    for k in [&pick_a, &pick_b] {
                        let la = list_local_pair_keys(&a_ctx.local_root)?;
                        let lb = list_local_pair_keys(&b_ctx.local_root)?;
                        assert!(!la.contains(k) && !lb.contains(k), "both clients must delete {} after global delete", k);
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 0).await?;
                    }
                    // Resurrect remote → both should redownload
                    remote_put_text(&a_ctx.s3, &bucket, &pick_a, "remote-resurrect-A\n").await?;
                    remote_put_text(&a_ctx.s3, &bucket, &pick_b, "remote-resurrect-B\n").await?;
                    let need_present: std::collections::HashSet<String> =
                        [pick_a.clone(), pick_b.clone()].into_iter().collect();
                    wait_remote_contains_all(&a_ctx.s3, &bucket, &need_present, &a_ctx, &b_ctx, check_iters).await?;
                    for _ in 0..rounds_delete_g {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    for k in [&pick_a, &pick_b] {
                        let la = list_local_pair_keys(&a_ctx.local_root)?;
                        let lb = list_local_pair_keys(&b_ctx.local_root)?;
                        assert!(la.contains(k) && lb.contains(k), "both clients must redownload resurrected {}", k);
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }

                    // 9) NEW — Never-adopted remote exists → local rename + both variants adopted by all peers
                    let na_key = format!("pair/ml-na-w{w:02}.txt");
                    let gid_na = Uuid::new_v4().simple().to_string();
                    remote_put_text(&a_ctx.s3, &bucket, &na_key, &format!("seed who:R gid:{gid_na}\n")).await?;
                    write_marked(&b_ctx.local_root, &na_key, &gid_na, "B", "never-adopted-local").await?;
                    for _ in 0..rounds_conflict { sync_both(&a_ctx, &b_ctx, 1).await?; }
                    let a_na = find_local_by_gid(&a_ctx.local_root, &gid_na)?;
                    let b_na = find_local_by_gid(&b_ctx.local_root, &gid_na)?;
                    assert!(distinct_body_count(&a_na) >= 2 && contains_body_from(&a_na,"R") && contains_body_from(&a_na,"B"),
                            "[MLD] A must adopt both variants");
                    assert!(distinct_body_count(&b_na) >= 2 && contains_body_from(&b_na,"R") && contains_body_from(&b_na,"B"),
                            "[MLD] B must adopt both variants");

                    // 10) NEW — Global rename initiated on server (copy+delete)
                    let gr_old = format!("pair/ml-gr-old-w{w:02}.txt");
                    let gr_new = format!("pair/ml-gr-old-w{w:02}-renamed.txt");
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
                                "[MLD] {} must adopt server-initiated rename (only new name)", ctx.name);
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
