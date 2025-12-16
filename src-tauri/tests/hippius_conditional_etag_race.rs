// tests/hippius_conditional_etag_race.rs
//
// Sanity checks that hippius-s3 implements If-None-Match and If-Match
// guards in a race-safe way. We fire racy writes from two clients at
// "the same time" and assert that exactly one wins and one gets a
// precondition failure (412 / PreconditionFailed).
//
// Uses the shared harness without modifying it.

use anyhow::{Context, Result};
use aws_sdk_s3::primitives::ByteStream;
use std::sync::Arc;
use tokio::sync::Barrier;

#[path = "hippius_policy_harness.rs"]
mod harness;

use harness::{boot_stack, env_usize, new_bucket, s3_client};

/// Helper: classify a PutObject error as "precondition failed" or not, and log
/// anything that doesn't look like a 412 / PreconditionFailed.
fn classify_precondition_error(
    ctx: &str,
    iter: usize,
    client: &str,
    key: &str,
    err: &impl std::fmt::Debug,
) -> bool {
    let s = format!("{err:?}");

    let looks_precond = s.contains("PreconditionFailed")
        || s.contains("Precondition failed")
        || s.contains("PRECONDITION_FAILED")
        || s.contains("412");

    if !looks_precond {
        eprintln!(
            "[{ctx}] iter:{iter} client:{client} key:{key} \
             got non-412/non-PreconditionFailed error: {s}"
        );
    }

    looks_precond
}

/// Racy creation with If-None-Match: "*".
/// Two concurrent clients try to create the same key from a cold start.
/// Expectation:
///   - exactly one PutObject succeeds,
///   - exactly one PutObject fails with a 412/PreconditionFailed.
#[tokio::test(flavor = "multi_thread")]
async fn if_none_match_racy_create_is_atomic() -> Result<()> {
    let boot = boot_stack().await?;
    let s3c = s3_client(&boot.s3_endpoint).await?;
    let bucket = new_bucket(&s3c).await?;

    // Tunable via env; defaults to a decent number of races.
    let iters = env_usize("HIPPIUS_ETAG_RACE_ITERS", 64);

    for i in 0..iters {
        let key = format!("pair/etag-race/if-none/{i}");
        let barrier = Arc::new(Barrier::new(2));

        let c_a = s3c.clone();
        let c_b = s3c.clone();
        let b_a = barrier.clone();
        let b_b = barrier.clone();
        let bucket_a = bucket.clone();
        let bucket_b = bucket.clone();
        let key_a = key.clone();
        let key_b = key.clone();

        let fut_a = async move {
            // Align both clients so PutObject goes out "at the same time".
            b_a.wait().await;
            c_a.put_object()
                .bucket(bucket_a)
                .key(key_a)
                .body(ByteStream::from_static(b"race-if-none-A\n"))
                .if_none_match("*")
                .send()
                .await
        };

        let fut_b = async move {
            b_b.wait().await;
            c_b.put_object()
                .bucket(bucket_b)
                .key(key_b)
                .body(ByteStream::from_static(b"race-if-none-B\n"))
                .if_none_match("*")
                .send()
                .await
        };

        let (res_a, res_b) = tokio::join!(fut_a, fut_b);

        let mut ok = 0usize;
        let mut precond = 0usize;
        let mut other_errors = 0usize;

        for (label, res) in [("A", res_a), ("B", res_b)] {
            match res {
                Ok(_) => {
                    ok += 1;
                }
                Err(e) => {
                    if classify_precondition_error("if-none-match", i, label, &key, &e) {
                        precond += 1;
                    } else {
                        other_errors += 1;
                    }
                }
            }
        }

        assert_eq!(
            ok, 1,
            "[if-none-match] iter {i}, key {key}: expected exactly 1 successful PutObject, got {ok}"
        );
        assert_eq!(
            precond, 1,
            "[if-none-match] iter {i}, key {key}: expected exactly 1 PreconditionFailed (412), got {precond}"
        );
        assert_eq!(
            other_errors, 0,
            "[if-none-match] iter {i}, key {key}: unexpected non-412 errors occurred"
        );
    }

    Ok(())
}

/// Racy update with If-Match: <etag>.
/// We seed an object, grab its ETag, then two clients concurrently try to
/// overwrite it using the same If-Match value. Expectation:
///   - exactly one PutObject succeeds,
///   - exactly one PutObject fails with a 412/PreconditionFailed,
///   - final object body is one of the two contenders.
#[tokio::test(flavor = "multi_thread")]
async fn if_match_racy_update_is_atomic() -> Result<()> {
    let boot = boot_stack().await?;
    let s3c = s3_client(&boot.s3_endpoint).await?;
    let bucket = new_bucket(&s3c).await?;

    let iters = env_usize("HIPPIUS_ETAG_RACE_ITERS", 32);

    for i in 0..iters {
        let key = format!("pair/etag-race/if-match/{i}");

        // Seed the object to get a starting ETag.
        let seed_out = s3c
            .put_object()
            .bucket(&bucket)
            .key(&key)
            .body(ByteStream::from_static(b"seed-body\n"))
            .send()
            .await
            .with_context(|| format!("seed PutObject for {key}"))?;

        let etag = seed_out
            .e_tag()
            .map(|s| s.to_string())
            .with_context(|| format!("seed PutObject for {key} missing ETag"))?;

        let barrier = Arc::new(Barrier::new(2));

        let c_a = s3c.clone();
        let c_b = s3c.clone();
        let b_a = barrier.clone();
        let b_b = barrier.clone();
        let bucket_a = bucket.clone();
        let bucket_b = bucket.clone();
        let key_a = key.clone();
        let key_b = key.clone();
        let etag_a = etag.clone();
        let etag_b = etag.clone();

        let fut_a = async move {
            b_a.wait().await;
            c_a.put_object()
                .bucket(bucket_a)
                .key(key_a)
                .body(ByteStream::from_static(b"race-if-match-A\n"))
                .if_match(etag_a)
                .send()
                .await
        };

        let fut_b = async move {
            b_b.wait().await;
            c_b.put_object()
                .bucket(bucket_b)
                .key(key_b)
                .body(ByteStream::from_static(b"race-if-match-B\n"))
                .if_match(etag_b)
                .send()
                .await
        };

        let (res_a, res_b) = tokio::join!(fut_a, fut_b);

        let mut ok = 0usize;
        let mut precond = 0usize;
        let mut other_errors = 0usize;

        for (label, res) in [("A", res_a), ("B", res_b)] {
            match res {
                Ok(_) => {
                    ok += 1;
                }
                Err(e) => {
                    if classify_precondition_error("if-match", i, label, &key, &e) {
                        precond += 1;
                    } else {
                        other_errors += 1;
                    }
                }
            }
        }

        assert_eq!(
            ok, 1,
            "[if-match] iter {i}, key {key}: expected exactly 1 successful PutObject, got {ok}"
        );
        assert_eq!(
            precond, 1,
            "[if-match] iter {i}, key {key}: expected exactly 1 PreconditionFailed (412), got {precond}"
        );
        assert_eq!(
            other_errors, 0,
            "[if-match] iter {i}, key {key}: unexpected non-412 errors occurred"
        );

        // Optional sanity check: winning body is one of the contenders.
        let final_body = harness::read_remote_text(&s3c, &bucket, &key).await?;
        assert!(
            final_body.contains("race-if-match-A")
                || final_body.contains("race-if-match-B"),
            "[if-match] iter {i}, key {key}: final body didn't match any contender; body was {:?}",
            final_body
        );
    }

    Ok(())
}
