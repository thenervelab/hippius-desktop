//! Short-lived cache of a drive's remote listing, for one-off downloads.
//!
//! hcfs verifies every download against the file's server row
//! (`ExpectedContent`: salted hash, size, revision). Its plain
//! `download_remote_file` finds that row by paging the drive's WHOLE listing,
//! once per download. A screen of thumbnails, a preview, then another preview
//! is one full listing each, so a large drive pays for its listing dozens of
//! times a minute. This cache keeps the rows from one listing per drive for a
//! short while and hands `download_remote_file_expecting` the row instead.
//!
//! Staleness is safe, not just tolerable: when the server serves a newer
//! revision than a cached row describes, hcfs looks the row up again and
//! retries once (`download_remote_file_expecting`). A file uploaded after
//! the cached listing is a miss here, which refetches once. The TTL and the
//! invalidation on each completed sync of the drive only bound how often
//! that slower path is taken.
//!
//! Concurrent lookups for one drive share a single fetch: the per-drive slot
//! is an async mutex held across the fetch, so the second caller waits and
//! then reads what the first fetched rather than paging the listing again.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use hcfs_client::drive::remote::ExpectedContent;
use hcfs_shared::network::RemoteFileEntry;

/// How long a fetched listing serves lookups. Long enough to cover a screen
/// of thumbnails and the preview opened from it; short enough that a change
/// made elsewhere is picked up without a sync.
const LISTING_TTL: Duration = Duration::from_secs(45);

/// Drives whose listing is kept at once. The cache serves what the user is
/// looking at, which is one drive or two; the bound keeps a session that
/// browses many drives from holding every listing it ever fetched.
const MAX_DRIVES: usize = 4;

/// One drive's listing as the server names it. The label alone is not
/// enough: a shared drive's rows live under its owner's namespace, and a
/// label can be reused by another account after a switch.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ListingKey {
    /// The drive's local label, the unit sync completion invalidates.
    label: String,
    /// The namespace owner the listing was fetched under.
    ss58: String,
    /// The drive's server folder hash.
    folder_hash: String,
}

/// The rows of one fetched listing, by path hash (the file id's bytes).
struct Listing {
    /// When the listing was fetched; it serves lookups for [`LISTING_TTL`].
    fetched_at: Instant,
    /// Each file's verification row.
    rows: HashMap<[u8; 32], ExpectedContent>,
}

/// A drive's slot: `None` until fetched. Async so a fetch in progress holds
/// it and concurrent lookups wait for that fetch instead of starting theirs.
type Slot = Arc<tokio::sync::Mutex<Option<Listing>>>;

/// Per-drive cache of remote listing rows; see the module docs.
pub struct RemoteListingCache {
    /// Each drive's slot and when it was last used, for eviction.
    slots: std::sync::Mutex<HashMap<ListingKey, (Instant, Slot)>>,
    /// How long a fetched listing is served.
    ttl: Duration,
    /// How many drives keep a slot.
    max_drives: usize,
}

impl std::fmt::Debug for RemoteListingCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteListingCache")
            .field("ttl", &self.ttl)
            .field("max_drives", &self.max_drives)
            .finish_non_exhaustive()
    }
}

impl Default for RemoteListingCache {
    fn default() -> Self {
        Self::with_limits(LISTING_TTL, MAX_DRIVES)
    }
}

impl RemoteListingCache {
    fn with_limits(ttl: Duration, max_drives: usize) -> Self {
        Self {
            slots: std::sync::Mutex::new(HashMap::new()),
            ttl,
            max_drives,
        }
    }

    /// Returns the verification row for `path_hash` in the drive's listing,
    /// fetching the listing with `fetch` only when no fresh one is held, or
    /// when a held one lacks the file (it may be newer than the listing).
    /// `None` when a freshly fetched listing does not have the file either.
    ///
    /// # Errors
    ///
    /// Whatever `fetch` returns; nothing is cached on an error.
    pub async fn expected<F, Fut, E>(
        &self,
        label: &str,
        ss58: &str,
        folder_hash: &str,
        path_hash: [u8; 32],
        fetch: F,
    ) -> Result<Option<ExpectedContent>, E>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<Vec<RemoteFileEntry>, E>>,
    {
        let key = ListingKey {
            label: label.to_string(),
            ss58: ss58.to_string(),
            folder_hash: folder_hash.to_string(),
        };
        let slot = self.slot(key);
        let mut held = slot.lock().await;

        if let Some(listing) = held.as_ref().filter(|listing| listing.fetched_at.elapsed() < self.ttl)
            && let Some(row) = listing.rows.get(&path_hash)
        {
            return Ok(Some(*row));
        }

        let listing = listing_from(fetch().await?);
        let row = listing.rows.get(&path_hash).copied();
        *held = Some(listing);
        Ok(row)
    }

    /// Drops every listing held for `label`. Called when a sync of the drive
    /// completes, since that cycle may have changed its rows.
    pub fn invalidate(&self, label: &str) {
        self.lock_slots().retain(|key, _| key.label != label);
    }

    /// Drops every listing. Called on account reset, when labels may be
    /// reused by the next account.
    pub fn clear_all(&self) {
        self.lock_slots().clear();
    }

    /// The drive's slot, created if absent, evicting the least recently used
    /// drive when the bound is reached.
    fn slot(&self, key: ListingKey) -> Slot {
        let mut slots = self.lock_slots();
        if !slots.contains_key(&key) && slots.len() >= self.max_drives {
            let oldest = slots.iter().min_by_key(|(_, (used, _))| *used).map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                slots.remove(&oldest);
            }
        }
        let entry = slots.entry(key).or_insert_with(|| (Instant::now(), Slot::default()));
        entry.0 = Instant::now();
        Arc::clone(&entry.1)
    }

    fn lock_slots(&self) -> std::sync::MutexGuard<'_, HashMap<ListingKey, (Instant, Slot)>> {
        // A poisoned map only loses cached rows, which the next lookup refetches.
        self.slots.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The verification rows of a fetched listing, the same fields hcfs's own
/// lookup reads.
fn listing_from(entries: Vec<RemoteFileEntry>) -> Listing {
    let rows = entries
        .into_iter()
        .map(|entry| {
            let expected = ExpectedContent {
                salted_hash: entry.salted_hash,
                size_bytes: entry.size_bytes,
                revision_id: entry.revision_id,
            };
            (entry.path_hash, expected)
        })
        .collect();
    Listing {
        fetched_at: Instant::now(),
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A server row built from its wire form, so the fixture follows the
    /// upstream struct's optional fields instead of listing each one.
    fn entry(byte: u8) -> RemoteFileEntry {
        serde_json::from_value(serde_json::json!({
            "path_hash": vec![byte; 32],
            "salted_hash": vec![byte.wrapping_add(1); 32],
            "size_bytes": u64::from(byte),
            "revision_seq": 1,
            "revision_id": vec![byte.wrapping_add(2); 32],
            "created_at": 0,
            "updated_at": 0,
        }))
        .unwrap()
    }

    /// A fake server listing that counts how often it is paged.
    struct FakeServer {
        listings: AtomicUsize,
        rows: std::sync::Mutex<Vec<u8>>,
    }

    impl FakeServer {
        fn with(rows: &[u8]) -> Self {
            Self {
                listings: AtomicUsize::new(0),
                rows: std::sync::Mutex::new(rows.to_vec()),
            }
        }

        async fn list(&self) -> Result<Vec<RemoteFileEntry>, String> {
            self.listings.fetch_add(1, Ordering::SeqCst);
            // Yield so concurrent lookups overlap with the fetch in progress.
            tokio::task::yield_now().await;
            Ok(self.rows.lock().unwrap().iter().copied().map(entry).collect())
        }

        fn listings(&self) -> usize {
            self.listings.load(Ordering::SeqCst)
        }
    }

    async fn lookup(cache: &RemoteListingCache, server: &FakeServer, label: &str, byte: u8) -> Option<ExpectedContent> {
        cache.expected(label, "owner", "folder", [byte; 32], || server.list()).await.unwrap()
    }

    #[tokio::test]
    async fn the_row_comes_from_the_listing() {
        let cache = RemoteListingCache::default();
        let server = FakeServer::with(&[7]);

        let row = lookup(&cache, &server, "photos", 7).await.expect("listed");

        assert_eq!(row.salted_hash, [8; 32]);
        assert_eq!(row.size_bytes, 7);
        assert_eq!(row.revision_id, [9; 32]);
    }

    /// The regression this exists for: a screen of thumbnails is one listing,
    /// not one per thumbnail, even when they all start at once.
    #[tokio::test]
    async fn concurrent_downloads_from_one_drive_share_one_listing() {
        let cache = RemoteListingCache::default();
        let server = FakeServer::with(&(0..20).collect::<Vec<_>>());

        let lookups = (0..20).map(|byte| lookup(&cache, &server, "photos", byte));
        let rows = futures_util::future::join_all(lookups).await;

        assert!(rows.iter().all(Option::is_some));
        assert_eq!(server.listings(), 1);
    }

    #[tokio::test]
    async fn a_completed_sync_invalidates_that_drive_only() {
        let cache = RemoteListingCache::default();
        let server = FakeServer::with(&[1]);
        lookup(&cache, &server, "photos", 1).await;
        lookup(&cache, &server, "docs", 1).await;

        cache.invalidate("photos");
        lookup(&cache, &server, "photos", 1).await;
        lookup(&cache, &server, "docs", 1).await;

        assert_eq!(server.listings(), 3, "photos refetched, docs still cached");
    }

    #[tokio::test]
    async fn an_expired_listing_is_fetched_again() {
        let cache = RemoteListingCache::with_limits(Duration::ZERO, MAX_DRIVES);
        let server = FakeServer::with(&[1]);

        lookup(&cache, &server, "photos", 1).await;
        lookup(&cache, &server, "photos", 1).await;

        assert_eq!(server.listings(), 2);
    }

    /// A file uploaded after the cached listing is not in it: refetch once
    /// rather than failing the download.
    #[tokio::test]
    async fn a_file_newer_than_the_listing_refetches_once() {
        let cache = RemoteListingCache::default();
        let server = FakeServer::with(&[1]);
        lookup(&cache, &server, "photos", 1).await;

        server.rows.lock().unwrap().push(2);
        assert!(lookup(&cache, &server, "photos", 2).await.is_some());
        assert_eq!(server.listings(), 2);

        assert!(lookup(&cache, &server, "photos", 3).await.is_none(), "not on the server at all");
        assert_eq!(server.listings(), 3, "one fetch per miss, no loop");
    }

    #[tokio::test]
    async fn a_failed_fetch_caches_nothing() {
        let cache = RemoteListingCache::default();
        let failed: Result<Option<ExpectedContent>, String> = cache
            .expected("photos", "owner", "folder", [1; 32], || async { Err("offline".to_string()) })
            .await;
        assert!(failed.is_err());

        let server = FakeServer::with(&[1]);
        assert!(lookup(&cache, &server, "photos", 1).await.is_some());
        assert_eq!(server.listings(), 1);
    }

    #[tokio::test]
    async fn the_least_recently_used_drive_is_evicted_at_the_bound() {
        let cache = RemoteListingCache::with_limits(LISTING_TTL, 2);
        let server = FakeServer::with(&[1]);
        lookup(&cache, &server, "a", 1).await;
        lookup(&cache, &server, "b", 1).await;
        lookup(&cache, &server, "a", 1).await;
        lookup(&cache, &server, "c", 1).await;

        lookup(&cache, &server, "a", 1).await;
        assert_eq!(server.listings(), 3, "a was used last, so b went");
        lookup(&cache, &server, "b", 1).await;
        assert_eq!(server.listings(), 4);
    }

    #[tokio::test]
    async fn an_account_reset_drops_every_listing() {
        let cache = RemoteListingCache::default();
        let server = FakeServer::with(&[1]);
        lookup(&cache, &server, "photos", 1).await;

        cache.clear_all();
        lookup(&cache, &server, "photos", 1).await;

        assert_eq!(server.listings(), 2);
    }
}
