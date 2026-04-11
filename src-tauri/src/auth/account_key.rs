use sha2::{Digest, Sha256};

/// Derive a 16-character hex account key from an account ID via SHA-256.
///
/// Used as the owner key for scoped credential storage (auth tokens, sync paths).
/// Only the first 8 bytes of the digest are encoded, producing exactly 16 hex chars.
pub fn account_key(account_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

/// Derive an 8-character hex account key (legacy format).
///
/// Superseded by [`account_key`] which produces 16 chars. Retained for
/// migration from the old storage format — see
/// [`crate::utils::schema::migrate_account_keys`], which runs on every
/// app startup and rewrites legacy 8-char `owner` columns to the new
/// 16-char format.
///
/// **Sunset criteria:** the migration shipped on **2026-03-13** (commit
/// `68573962`). Delete this function, `account_key_legacy_is_8_chars` and
/// `new_key_starts_with_legacy` tests, and the entire `migrate_account_keys`
/// helper once any of these is true:
/// 1. Six months have passed since 2026-03-13 (i.e. after **2026-09-13**)
///    AND no `Migrating account key` warn log has been observed in
///    production telemetry for 30+ days, OR
/// 2. The minimum supported app version is bumped past a release that
///    shipped after 2026-03-13 + a forced-upgrade window, OR
/// 3. A schema migration is performed that resets owner columns anyway.
pub fn account_key_legacy(account_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..4])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_key_is_16_chars() {
        let key = account_key("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
        assert_eq!(key.len(), 16);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn account_key_legacy_is_8_chars() {
        let key = account_key_legacy("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
        assert_eq!(key.len(), 8);
    }

    #[test]
    fn new_key_starts_with_legacy() {
        let addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        let new_key = account_key(addr);
        let legacy = account_key_legacy(addr);
        assert!(new_key.starts_with(&legacy));
    }

    #[test]
    fn account_key_is_deterministic() {
        let addr = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
        assert_eq!(account_key(addr), account_key(addr));
    }
}
