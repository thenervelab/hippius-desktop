//! Per-account single-flight cache for indexer-backed billing fetches.
//!
//! A process-wide `tokio::sync::Mutex` around the whole map would make
//! account B wait on account A's indexer round-trip. The slot map is a
//! `std::sync::Mutex` (never held across `.await`); each account owns
//! its own `tokio::sync::Mutex` so same-account callers share one fetch
//! and other accounts proceed in parallel.

use crate::error::AppError;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct CacheEntry<T> {
    fetched_at: Instant,
    value: T,
}

type AccountSlot<T> = Arc<tokio::sync::Mutex<Option<CacheEntry<T>>>>;

/// TTL cache keyed by account id, with one in-flight fetch per key.
pub struct PerAccountCache<T> {
    slots: Mutex<HashMap<String, AccountSlot<T>>>,
    ttl: Duration,
}

impl<T: Clone> PerAccountCache<T> {
    pub fn new(ttl: Duration) -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    /// Return a live cache hit, or run `fetch` under the account's lock
    /// so concurrent callers of the same id share one round-trip.
    ///
    /// A failed fetch is not stored — the next caller retries.
    pub async fn get_or_fetch<F, Fut>(&self, account_id: &str, fetch: F) -> Result<T, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, AppError>>,
    {
        let slot = {
            let mut map = self.slots.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            map.entry(account_id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
                .clone()
        };

        let mut guard = slot.lock().await;
        if let Some(entry) = guard.as_ref()
            && entry.fetched_at.elapsed() < self.ttl
        {
            return Ok(entry.value.clone());
        }

        let value = fetch().await?;
        *guard = Some(CacheEntry {
            fetched_at: Instant::now(),
            value: value.clone(),
        });
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn same_account_single_flights() {
        let cache = Arc::new(PerAccountCache::new(Duration::from_secs(30)));
        let hits = Arc::new(AtomicU32::new(0));

        let run = |cache: Arc<PerAccountCache<u32>>, hits: Arc<AtomicU32>| async move {
            cache
                .get_or_fetch("acct", || {
                    hits.fetch_add(1, Ordering::SeqCst);
                    async {
                        tokio::time::sleep(Duration::from_millis(40)).await;
                        Ok::<_, AppError>(7)
                    }
                })
                .await
        };

        let (a, b) = tokio::join!(run(cache.clone(), hits.clone()), run(cache, hits.clone()));
        assert_eq!(a.expect("first"), 7);
        assert_eq!(b.expect("second"), 7);
        assert_eq!(hits.load(Ordering::SeqCst), 1, "same account must share one fetch");
    }

    #[tokio::test]
    async fn different_accounts_fetch_in_parallel() {
        let cache = Arc::new(PerAccountCache::new(Duration::from_secs(30)));
        let hits = Arc::new(AtomicU32::new(0));
        let started = Instant::now();

        let run = |cache: Arc<PerAccountCache<u32>>, hits: Arc<AtomicU32>, acct: &'static str, value: u32| async move {
            cache
                .get_or_fetch(acct, || {
                    hits.fetch_add(1, Ordering::SeqCst);
                    async move {
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        Ok::<_, AppError>(value)
                    }
                })
                .await
        };

        let (a, b) = tokio::join!(
            run(cache.clone(), hits.clone(), "acct-a", 1),
            run(cache.clone(), hits.clone(), "acct-b", 2),
        );
        assert_eq!(a.expect("a"), 1, "acct-a must not receive acct-b's value");
        assert_eq!(b.expect("b"), 2, "acct-b must not receive acct-a's value");
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        let leaked = cache.get_or_fetch("acct-b", || async { Ok::<_, AppError>(7) }).await.expect("cached b");
        assert_eq!(leaked, 2, "a later fetch of acct-b must not see another account");
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "two accounts must not serialize behind one global lock"
        );
    }

    #[tokio::test]
    async fn failed_fetch_is_not_cached() {
        let cache = PerAccountCache::<u32>::new(Duration::from_secs(30));
        let hits = AtomicU32::new(0);

        let first = cache
            .get_or_fetch("acct", || {
                hits.fetch_add(1, Ordering::SeqCst);
                async { Err(AppError::Other("boom".into())) }
            })
            .await;
        assert!(first.is_err());

        let second = cache
            .get_or_fetch("acct", || {
                hits.fetch_add(1, Ordering::SeqCst);
                async { Ok::<_, AppError>(3) }
            })
            .await;
        assert_eq!(second.expect("retry"), 3);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn expired_entry_is_refetched() {
        let cache = PerAccountCache::new(Duration::from_millis(10));
        let hits = AtomicU32::new(0);

        let first = cache
            .get_or_fetch("acct", || {
                hits.fetch_add(1, Ordering::SeqCst);
                async { Ok::<_, AppError>(1) }
            })
            .await;
        assert_eq!(first.expect("first"), 1);

        tokio::time::sleep(Duration::from_millis(20)).await;

        let second = cache
            .get_or_fetch("acct", || {
                hits.fetch_add(1, Ordering::SeqCst);
                async { Ok::<_, AppError>(2) }
            })
            .await;
        assert_eq!(second.expect("second"), 2);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }
}
