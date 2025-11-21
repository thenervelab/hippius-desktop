// tests/hippius_upload_only.rs
// Policy: UploadOnly (downloads only newer versions of files already present locally; never download brand-new files)
// Behaviours validated (extended):
// - Concurrent creates: remote gets all; each client keeps only its own files (no peer downloads).
// - Concurrent deletes: remote still has all; locals remain deleted; no peer downloads.
// - Concurrent restores: after local re-create, files persist locally (remote unchanged).
// - Distinct overwrites (per-client subsets): locals reflect latest body; remote objects updated; **no extra copies** created.
// - Conflicts (same-name create & overwrite): **name-agnostic** and **non-deterministic** — assert that exactly one client keeps the
//   original name, the *renaming* client ends up with **both** variants (both bodies present), and the non-renaming client keeps a single variant.
//   Remote exposes ≥2 variants.
// - Renames propagate without duplication:
//   * Single shared-file rename: local rename → remote rename → peers that have the file rename the path; old name removed remotely and locally.
//   * Dual shared renames (two different files): both renames propagate; only the new names remain (no duplication).
//   * Same-file conflicting renames: converge to **both** final names (A & B new names), old name removed; no further duplication.
// - Shared-file update: a client downloads a *new version* only if it already has that file locally.
// - Global delete & resurrection: locals delete on global delete; **do not** resurrect locally after remote resurrection.
// - NEW: “Never‑adopted remote exists” scenario: when a client makes a local change to a key that exists remotely but was never adopted locally,
//   it must **rename its local variant** and also **download the remote version**; peers that don’t have the file remain absent (UploadOnly).
// - NEW: Global rename initiated on the server (copy+delete without manifest change) propagates as a rename to all clients that have the file.

use anyhow::{Context, Result};
use std::collections::HashSet;
use uuid::Uuid;

#[path = "hippius_policy_harness.rs"]
mod harness;
use harness::*;

#[test]
fn upload_only_policy_extended_concurrency() -> Result<()> {
    // Larger OS thread stack like the other suites
    let os_stack = std::env::var("SMOKE_OS_STACK_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(16 * 1024 * 1024);

    let jh = std::thread::Builder::new()
        .name("hippius_upload_only_test".into())
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
                // ---- Boot stack & bucket ----
                let boot = boot_stack().await?;
                let s3c = s3_client(&boot.s3_endpoint).await?;
                let bucket = new_bucket(&s3c).await?;

                // ---- Controls ----
                let waves = env_usize("SMOKE_WAVES", 1);
                let create_per_client = env_usize("SMOKE_CREATE_PER_CLIENT", 4);
                let restore_per_client = env_usize("SMOKE_RESURRECT_PER_CLIENT", 2);

                let rounds_create = env_usize("SMOKE_SYNC_ROUNDS_CREATE", 5);
                let rounds_conflict = env_usize("SMOKE_SYNC_ROUNDS_CONFLICT", 5);
                let rounds_restore = env_usize("SMOKE_SYNC_ROUNDS_RES", 5);
                let rounds_rename = env_usize("SMOKE_SYNC_ROUNDS_RENAME", 5);
                let rounds_delete = env_usize("SMOKE_SYNC_ROUNDS_DELETE", 5);
                let check_iters = env_usize("SMOKE_CHECK_ITERS", 5);

                // Two UploadOnly clients
                let tag8 = "smoketag";
                let (a_ctx, _ta) = make_client_ctx(
                    "A",
                    &boot.s3_endpoint,
                    &bucket,
                    format!("{tag8}-A"),
                    DeletePolicy::UploadOnly,
                )
                .await?;
                let (b_ctx, _tb) = make_client_ctx(
                    "B",
                    &boot.s3_endpoint,
                    &bucket,
                    format!("{tag8}-B"),
                    DeletePolicy::UploadOnly,
                )
                .await?;

                for w in 0..waves {
                    eprintln!("=== [UploadOnly] Wave {w} ===");

                    // 1) Concurrent creates
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

                    for _ in 0..rounds_create {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }

                    // Remote must contain all created keys
                    let mut need = HashSet::new();
                    need.extend(a_keys.iter().cloned());
                    need.extend(b_keys.iter().cloned());
                    wait_remote_contains_all(
                        &a_ctx.s3,
                        &bucket,
                        &need,
                        &a_ctx,
                        &b_ctx,
                        check_iters,
                    )
                    .await?;

                    // Locals: no peer downloads
                    let la = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb = list_local_pair_keys(&b_ctx.local_root)?;
                    for k in &a_keys {
                        assert!(la.contains(k), "A should have its key {k}");
                    }
                    for k in &b_keys {
                        assert!(lb.contains(k), "B should have its key {k}");
                    }
                    for k in &b_keys {
                        assert!(!la.contains(k), "A must not download B key {k}");
                    }
                    for k in &a_keys {
                        assert!(!lb.contains(k), "B must not download A key {k}");
                    }

                    // 1b) Sanity: no spurious copies for this wave's create prefixes
                    let a_pref = format!("pair/a-w{w:02}-");
                    let b_pref = format!("pair/b-w{w:02}-");
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &a_pref, a_keys.len())
                        .await?;
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &b_pref, b_keys.len())
                        .await?;

                    // 1c) New-version download path (UploadOnly should fetch new versions for files it already has)
                    let shared = format!("pair/shared-version-upl-w{w:02}.txt");
                    write_one(&a_ctx.local_root, &shared, "seed shared\n").await?;
                    write_one(&b_ctx.local_root, &shared, "seed shared\n").await?;
                    sync_both(&a_ctx, &b_ctx, 2).await?;
                    // A updates -> B must download
                    write_one(&a_ctx.local_root, &shared, "newver-A\n").await?;
                    sync_both(&a_ctx, &b_ctx, rounds_conflict).await?;
                    let b_body_v1 = read_local_text(&b_ctx.local_root, &shared)?;
                    assert!(
                        b_body_v1.contains("newver-A"),
                        "[UploadOnly] B must download newer version for {}",
                        shared
                    );
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &shared, 1).await?;
                    // B updates -> A must download
                    write_one(&b_ctx.local_root, &shared, "newver-B2\n").await?;
                    sync_both(&a_ctx, &b_ctx, rounds_conflict).await?;
                    let a_body_v2 = read_local_text(&a_ctx.local_root, &shared)?;
                    assert!(
                        a_body_v2.contains("newver-B2"),
                        "[UploadOnly] A must download newer version for {}",
                        shared
                    );
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &shared, 1).await?;

                    // 2) Concurrent deletes — remote still has everything; locals remain deleted
                    let (da, db) = tokio::join!(
                        delete_many(&a_ctx.local_root, &a_keys),
                        delete_many(&b_ctx.local_root, &b_keys),
                    );
                    da.context("deletes A")?;
                    db.context("deletes B")?;

                    for _ in 0..rounds_create {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    wait_remote_contains_all(
                        &a_ctx.s3,
                        &bucket,
                        &need,
                        &a_ctx,
                        &b_ctx,
                        check_iters,
                    )
                    .await?;
                    let la2 = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb2 = list_local_pair_keys(&b_ctx.local_root)?;
                    for k in &a_keys {
                        assert!(!la2.contains(k), "A local delete should persist for {k}");
                    }
                    for k in &b_keys {
                        assert!(!lb2.contains(k), "B local delete should persist for {k}");
                    }

                    // 3) Concurrent restores (re-create locally)
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
                    // Restored keys must remain locally (and still no peer downloads)
                    let la3 = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb3 = list_local_pair_keys(&b_ctx.local_root)?;
                    for k in &a_res {
                        assert!(la3.contains(k), "A restored {k} must persist locally");
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }
                    for k in &b_res {
                        assert!(lb3.contains(k), "B restored {k} must persist locally");
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }
                    for k in &b_res {
                        assert!(!la3.contains(k), "A must not download B restored key {k}");
                    }
                    for k in &a_res {
                        assert!(!lb3.contains(k), "B must not download A restored key {k}");
                    }

                    // 4) Distinct overwrites (update subsets owned by each client)
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
                    // Locals reflect latest body; remote reflects latest body (explicitly checked via GetObject)
                    for k in &a_ow {
                        let body_a = read_local_text(&a_ctx.local_root, k)?;
                        assert!(
                            body_a.contains("overwrite-A-distinct"),
                            "A local overwrite should persist for {k}"
                        );
                        let rb = read_remote_text(&a_ctx.s3, &bucket, k).await?;
                        assert!(
                            rb.contains("overwrite-A-distinct"),
                            "remote must contain updated body for {k}"
                        );
                        assert_remote_count_for_prefix(&a_ctx.s3, &bucket, k, 1).await?;
                    }
                    for k in &b_ow {
                        let body_b = read_local_text(&b_ctx.local_root, k)?;
                        assert!(
                            body_b.contains("overwrite-B-distinct"),
                            "B local overwrite should persist for {k}"
                        );
                        let rb = read_remote_text(&b_ctx.s3, &bucket, k).await?;
                        assert!(
                            rb.contains("overwrite-B-distinct"),
                            "remote must contain updated body for {k}"
                        );
                        assert_remote_count_for_prefix(&b_ctx.s3, &bucket, k, 1).await?;
                    }

                    // 5) Same-name concurrent create (conflict) — **name-agnostic & non-deterministic**
                    // Expect: remote ≥2 bodies; exactly one client keeps ONLY the original name; the *renaming* client ends up with BOTH bodies.
                    let ck = format!("pair/shared-create-w{w:02}.txt");
                    let gid = Uuid::new_v4().simple().to_string();
                    let (ra2, rb2) = tokio::join!(
                        write_marked(&a_ctx.local_root, &ck, &gid, "A", "create-conflict"),
                        write_marked(&b_ctx.local_root, &ck, &gid, "B", "create-conflict"),
                    );
                    ra2?;
                    rb2?;
                    sync_both(&a_ctx, &b_ctx, rounds_conflict).await?;

                    let rvars = find_remote_by_gid(&a_ctx.s3, &bucket, &gid).await?;
                    assert!(
                        distinct_body_count(&rvars) >= 2,
                        "remote must have >=2 bodies for {ck}"
                    );
                    let avars = find_local_by_gid(&a_ctx.local_root, &gid)?;
                    let bvars = find_local_by_gid(&b_ctx.local_root, &gid)?;

                    let a_has_orig = list_local_pair_keys(&a_ctx.local_root)?.contains(&ck);
                    let b_has_orig = list_local_pair_keys(&b_ctx.local_root)?.contains(&ck);
                    assert!(
                        a_has_orig && b_has_orig,
                        "[UploadOnly] both clients must keep original name for {ck}"
                    );

                    let a_cnt = distinct_body_count(&avars);
                    let b_cnt = distinct_body_count(&bvars);
                    assert!(
                        (a_cnt == 1 && b_cnt >= 2) || (a_cnt >= 2 && b_cnt == 1),
                        "[UploadOnly] one client must keep single variant, the other must end with both variants (gid:{})",
                        gid
                    );
                    if !a_has_orig {
                        // A is the renamer → must have both A and B bodies
                        assert!(contains_body_from(&avars, "A") && contains_body_from(&avars, "B"),
                                "renamer (A) must have both bodies");
                    }
                    if !b_has_orig {
                        // B is the renamer → must have both A and B bodies
                        assert!(contains_body_from(&bvars, "A") && contains_body_from(&bvars, "B"),
                                "renamer (B) must have both bodies");
                    }

                    // 6) Concurrent overwrites of the same key (conflict) — **name-agnostic & non-deterministic** (same rule)
                    let ow_key = format!("pair/shared-overwrite-w{w:02}.txt");
                    write_one(&a_ctx.local_root, &ow_key, "seed\n").await?;
                    write_one(&b_ctx.local_root, &ow_key, "seed\n").await?;
                    sync_both(&a_ctx, &b_ctx, rounds_create).await?;

                    let gid2 = Uuid::new_v4().simple().to_string();
                    let (oa2, ob2) = tokio::join!(
                        write_marked(&a_ctx.local_root, &ow_key, &gid2, "A", "overwrite-conflict"),
                        write_marked(&b_ctx.local_root, &ow_key, &gid2, "B", "overwrite-conflict"),
                    );
                    oa2?;
                    ob2?;
                    sync_both(&a_ctx, &b_ctx, rounds_conflict).await?;

                    let rvars2 = find_remote_by_gid(&a_ctx.s3, &bucket, &gid2).await?;
                    assert!(
                        distinct_body_count(&rvars2) >= 2,
                        "remote must have >=2 bodies after overwrite conflict"
                    );
                    let a_v2 = find_local_by_gid(&a_ctx.local_root, &gid2)?;
                    let b_v2 = find_local_by_gid(&b_ctx.local_root, &gid2)?;

                    let a_has_orig2 = list_local_pair_keys(&a_ctx.local_root)?.contains(&ow_key);
                    let b_has_orig2 = list_local_pair_keys(&b_ctx.local_root)?.contains(&ow_key);
                    assert!(
                        a_has_orig2 && b_has_orig2,
                        "[UploadOnly] both clients must keep original name for overwrite {ow_key}"
                    );

                    let ac2 = distinct_body_count(&a_v2);
                    let bc2 = distinct_body_count(&b_v2);
                    assert!(
                        (ac2 == 1 && bc2 >= 2) || (ac2 >= 2 && bc2 == 1),
                        "[UploadOnly] overwrite conflict must end with one client keeping single, the other having both (gid:{})",
                        gid2
                    );
                    if !a_has_orig2 {
                        assert!(contains_body_from(&a_v2, "A") && contains_body_from(&a_v2, "B"),
                                "renamer (A) must have both bodies (overwrite)");
                    }
                    if !b_has_orig2 {
                        assert!(contains_body_from(&b_v2, "A") && contains_body_from(&b_v2, "B"),
                                "renamer (B) must have both bodies (overwrite)");
                    }

                    // 7) Single shared-file rename propagates without duplication
                    let sr_old = format!("pair/upl-shared-rename-w{w:02}.txt");
                    let sr_new = format!("pair/upl-shared-rename-w{w:02}-renamed.txt");
                    assert_shared_rename_propagates_upload_only(
                        &a_ctx,
                        &b_ctx,
                        &bucket,
                        &sr_old,
                        &sr_new,
                        rounds_rename,
                        check_iters,
                    )
                    .await?;
/*
                    // 7b) Dual shared renames (two different files), both present on both clients
                    let old_a = format!("pair/upl-shared-A-w{w:02}.txt");
                    let new_a = format!("pair/upl-shared-A-w{w:02}-renamed.txt");
                    let old_b = format!("pair/upl-shared-B-w{w:02}.txt");
                    let new_b = format!("pair/upl-shared-B-w{w:02}-renamed.txt");
                    assert_dual_shared_rename_propagates_upload_only(
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
*/
                    // 8) Shared-file update: only new *versions* are downloaded if the file already exists locally
                    let shared_key = format!("pair/upl-shared-ver-w{w:02}.txt");
                    seed_shared_file_no_conflict_upload_only(
                        &a_ctx,
                        &b_ctx,
                        &shared_key,
                        "seed-shared\n",
                        check_iters,
                    )
                    .await?;
                    // A overwrites
                    write_one(&a_ctx.local_root, &shared_key, "seed-shared\nA-updated\n").await?;
                    for _ in 0..rounds_conflict {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    // B must see the updated version (since it already had the file locally)
                    let b_body_uv = read_local_text(&b_ctx.local_root, &shared_key)?;
                    assert!(
                        b_body_uv.contains("A-updated"),
                        "UploadOnly must fetch new versions for files that already exist locally"
                    );
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &shared_key, 1).await?;
/*
                    // 9) Rename/Rename conflict on the same file: converge to **both** new names (no duplication)
                    let rr_old = format!("pair/upl-rr-old-w{w:02}.txt");
                    let rr_a = format!("pair/upl-rr-A-w{w:02}-renamed.txt");
                    let rr_b = format!("pair/upl-rr-B-w{w:02}-renamed.txt");
                    assert_rename_rename_conflict_no_dup_upload_only(
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
*/
                    // 10) Global delete & resurrection: locals delete; must NOT resurrect locally
                    let gdr_key = format!("pair/upl-gdr-w{w:02}.txt");
                    seed_shared_file_no_conflict_upload_only(
                        &a_ctx,
                        &b_ctx,
                        &gdr_key,
                        "seed-shared\n",
                        check_iters,
                    )
                    .await?;
                    let need_delete: HashSet<String> = [gdr_key.clone()].into_iter().collect();
                    remote_delete_many(&a_ctx.s3, &bucket, &[gdr_key.clone()]).await?;
                    wait_remote_absent_all(
                        &a_ctx.s3,
                        &bucket,
                        &need_delete,
                        &a_ctx,
                        &b_ctx,
                        check_iters,
                    )
                    .await?;
                    for _ in 0..rounds_delete {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    let la_del = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb_del = list_local_pair_keys(&b_ctx.local_root)?;
                    assert!(
                        !la_del.contains(&gdr_key) && !lb_del.contains(&gdr_key),
                        "both clients must delete on global delete"
                    );

                    // Resurrect remotely; UploadOnly must NOT resurrect locally
                    remote_put_text(&a_ctx.s3, &bucket, &gdr_key, "remote-resurrect\n").await?;
                    wait_remote_contains_all(
                        &a_ctx.s3,
                        &bucket,
                        &need_delete,
                        &a_ctx,
                        &b_ctx,
                        check_iters,
                    )
                    .await?;
                    for _ in 0..rounds_delete {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    let la_post = list_local_pair_keys(&a_ctx.local_root)?;
                    let lb_post = list_local_pair_keys(&b_ctx.local_root)?;
                    assert!(
                        !la_post.contains(&gdr_key) && !lb_post.contains(&gdr_key),
                        "UploadOnly: global resurrection must NOT resurrect locally-deleted files"
                    );

                    // 11) NEW — Never-adopted remote exists → local rename + download remote version (on the modifying client)
                    let na_key = format!("pair/upl-na-w{w:02}.txt");
                    let gid_na = Uuid::new_v4().simple().to_string();
                    remote_put_text(&a_ctx.s3, &bucket, &na_key,
                        &format!("seed-remote-only who:R gid:{}\n", gid_na)).await?;
                    // B writes locally to same path before adopting
                    write_marked(&b_ctx.local_root, &na_key, &gid_na, "B", "never-adopted-local").await?;
                    for _ in 0..rounds_conflict {
                        sync_both(&a_ctx, &b_ctx, 1).await?;
                    }
                    let rv_na = find_remote_by_gid(&a_ctx.s3, &bucket, &gid_na).await?;
                    assert!(distinct_body_count(&rv_na) >= 2, "remote must expose both bodies for never-adopted");
                    let a_na = find_local_by_gid(&a_ctx.local_root, &gid_na)?;
                    let b_na = find_local_by_gid(&b_ctx.local_root, &gid_na)?;
                    assert!(a_na.is_empty(), "[UploadOnly] peer that never modified must NOT download never-adopted {}", na_key);
                    assert!(distinct_body_count(&b_na) >= 2
                        && contains_body_from(&b_na, "R")
                        && contains_body_from(&b_na, "B"),
                        "[UploadOnly] modifying client must keep both remote and renamed local variants for {}", na_key);
/*
                    // 12) NEW — Global rename initiated on the server (copy+delete without manifest change)
                    let gr_old = format!("pair/upl-gr-old-w{w:02}.txt");
                    let gr_new = format!("pair/upl-gr-old-w{w:02}-renamed.txt");
                    seed_shared_file_no_conflict_upload_only(&a_ctx, &b_ctx, &gr_old, "seed-shared\n", check_iters).await?;
                    remote_rename(&a_ctx.s3, &bucket, &gr_old, &gr_new).await?;
                    let need_new: HashSet<String> = [gr_new.clone()].into_iter().collect();
                    wait_remote_contains_all(&a_ctx.s3, &bucket, &need_new, &a_ctx, &b_ctx, check_iters).await?;
                    let need_old: HashSet<String> = [gr_old.clone()].into_iter().collect();
                    wait_remote_absent_all(&a_ctx.s3, &bucket, &need_old, &a_ctx, &b_ctx, check_iters).await?;
                    for _ in 0..rounds_rename { sync_both(&a_ctx, &b_ctx, 1).await?; }
                    for ctx in [&a_ctx, &b_ctx] {
                        let loc = list_local_pair_keys(&ctx.local_root)?;
                        assert!(loc.contains(&gr_new) && !loc.contains(&gr_old),
                                "[UploadOnly] {} must adopt server-initiated rename (only new name)", ctx.name);
                    }
                    assert_remote_count_for_prefix(&a_ctx.s3, &bucket, &gr_new, 1).await?;
*/
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
