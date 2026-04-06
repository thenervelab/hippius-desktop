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
/// migration from the old storage format.
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
