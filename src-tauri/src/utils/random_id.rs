//! A random, effectively-unique identifier string.
//!
//! Both call sites (a temp-file discriminator in [`crate::utils::logs`] and
//! an OAuth CSRF token in [`crate::auth::oauth`]) only need an
//! unpredictable, collision-resistant string — not RFC 4122 semantics — but
//! the UUID v4 shape is kept so the value stays familiar to read/log and no
//! consumer is surprised by a differently-shaped string.

/// Returns a random 128-bit identifier formatted as a UUID v4 string, e.g.
/// `"3fa85f64-5717-4562-b3fc-2c963f66afa6"`.
///
/// Backed by `rand`'s thread-local CSPRNG (reseeded from the OS), the same
/// entropy source the `uuid` crate's own `v4` feature used.
pub fn random_id() -> String {
    let mut bytes: [u8; 16] = rand::random();

    // RFC 4122 version 4 (random) + variant bits — cosmetic only, neither
    // call site depends on this, but it keeps the familiar UUID shape.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

#[cfg(test)]
mod tests {
    use super::random_id;

    #[test]
    fn has_uuid_v4_shape() {
        let id = random_id();
        let parts: Vec<&str> = id.split('-').collect();

        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), [8, 4, 4, 4, 12]);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        assert!(parts[2].starts_with('4'), "version nibble must be 4, got {}", parts[2]);
        assert!(
            matches!(parts[3].chars().next(), Some('8' | '9' | 'a' | 'b')),
            "variant nibble must be 8/9/a/b, got {}",
            parts[3]
        );
    }

    #[test]
    fn is_unique_across_calls() {
        let seen: std::collections::HashSet<String> = (0..1000).map(|_| random_id()).collect();
        assert_eq!(seen.len(), 1000);
    }
}
