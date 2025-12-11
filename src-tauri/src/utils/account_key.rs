use sha2::{Digest, Sha256};

/// Deterministic short key derived from the main account id to namespace per-user data.
pub fn account_key(account_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest)[..8].to_string()
}
