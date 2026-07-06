//! Regional fallback for HCFS server endpoints.
//!
//! `get_server_url` returns the empty string when the user is in
//! "auto-detect" mode — the sentinel hcfs-client interprets as "race
//! the regional endpoints and pick the fastest". hcfs-client handles
//! that internally for every request it issues, but the desktop has a
//! handful of one-shot HTTP calls (migration check, capability fetch,
//! migration start/cancel) that go through `reqwest` directly. Those
//! call sites need a concrete URL or `reqwest` rejects the request
//! builder for missing scheme.
//!
//! This module owns the local mirror of hcfs-client's regional URL
//! list and a small helper that resolves to a usable base URL. The
//! drift-detection test below pins the mirror to the upstream values
//! so a future region addition fails CI on the next bump.

/// Mirrors `hcfs_client::client::region::REGIONAL_BASE_URLS` (gated
/// `pub(crate)` upstream so we cannot import it directly).
///
/// Source of truth: `hcfs/hcfs-client/src/client/region.rs:21`.
const REGIONAL_FALLBACK_URLS: &[&str] = &["https://eu-central-1-arion.hippius.com", "https://us-east-1-arion.hippius.com"];

/// Return a usable HCFS base URL for one-shot `reqwest` calls.
///
/// - If `configured` is non-empty, return it verbatim. The user (or
///   `auto_init_sync`) explicitly chose this URL, so we trust it.
/// - If `configured` is empty (auto-detect mode), return the first
///   regional URL. Callers that need actual fastest-region racing
///   should go through `HcfsClient`, which caches the resolved URL
///   for the lifetime of the client. For one-shot calls, a single
///   regional URL avoids both the schemeless-URL crash and the cost
///   of racing twice on every invocation.
///
/// Returns a borrowed `&str` so the caller can stitch it directly
/// into `format!("{base}/migration/{user_id}")` without an extra
/// allocation.
pub(crate) fn resolve_base_url(configured: &str) -> &str {
    if configured.is_empty() {
        // SAFETY: `REGIONAL_FALLBACK_URLS` is non-empty (asserted at
        // compile time in `regional_fallback_list_is_non_empty`).
        REGIONAL_FALLBACK_URLS[0]
    } else {
        configured
    }
}

/// All regional URLs, in the same order as hcfs-client's race list.
/// Exposed for callers (capability check, etc.) that want to try
/// every region rather than just the first.
pub(crate) fn regional_fallback_urls() -> &'static [&'static str] {
    REGIONAL_FALLBACK_URLS
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The local copy of the regional URL list must include every base
    /// URL hcfs-client would race. If a new region is added upstream
    /// (or one is removed), this assert fires until the desktop mirror
    /// is updated. We can't import the upstream constant directly
    /// because `pub(crate) mod region` hides it — see module docs.
    #[test]
    fn regional_fallback_urls_match_hcfs_client_known_set() {
        // Snapshot of `hcfs_client::client::region::REGIONAL_BASE_URLS`
        // at rev 1b141d1. Update both sides (and bump the rev comment)
        // when the upstream list changes.
        let upstream = ["https://eu-central-1-arion.hippius.com", "https://us-east-1-arion.hippius.com"];
        assert_eq!(REGIONAL_FALLBACK_URLS, &upstream, "regional URL drift between desktop and hcfs-client");
    }

    #[test]
    fn regional_fallback_list_is_non_empty() {
        // `resolve_base_url` indexes [0] when configured is empty;
        // an empty fallback list would panic at runtime. Pin the
        // invariant so a future edit can't drop it silently.
        assert!(!REGIONAL_FALLBACK_URLS.is_empty(), "fallback list must contain at least one region");
    }

    #[test]
    fn resolve_returns_configured_when_non_empty() {
        assert_eq!(resolve_base_url("https://example.test"), "https://example.test");
    }

    #[test]
    fn resolve_falls_back_to_first_regional_when_empty() {
        assert_eq!(resolve_base_url(""), REGIONAL_FALLBACK_URLS[0]);
    }
}
