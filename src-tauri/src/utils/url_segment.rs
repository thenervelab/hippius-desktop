//! Values that go into a request's path: drive hashes, invite ids, account
//! addresses and link tokens.
//!
//! They come from the server, from the database or from the webview, and a
//! request URL is built by formatting them in. A value carrying `/`, `..`,
//! `?` or `#` would point the request (with the account's bearer token) at a
//! different route than the one meant, so each one is checked against the
//! strict alphabet every real value uses before it goes in.

use crate::error::{AppError, Result};

/// The longest value accepted. Hashes are 64 hex characters, account
/// addresses 48, link tokens shorter; nothing real comes near this.
const MAX_LEN: usize = 128;

/// `value` when it is safe as one path segment: 1 to [`MAX_LEN`] ASCII
/// letters, digits, `-` or `_`.
///
/// # Errors
///
/// [`AppError::Validation`] for anything else, which no real id is.
pub fn segment(value: &str) -> Result<&str> {
    if is_segment(value) {
        Ok(value)
    } else {
        Err(AppError::Validation("That link or drive isn't valid.".into()))
    }
}

/// Whether `value` is safe as one path segment ([`segment`]).
#[must_use]
pub fn is_segment(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_LEN && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_ids_pass() {
        for value in [
            "a3f9c0d2e1b4a5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c",
            "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
            "q9X2vLk7RtY4mN8pB3cZ1w",
            "inv_01-AbC",
        ] {
            assert_eq!(segment(value).unwrap(), value);
        }
    }

    #[test]
    fn anything_that_could_change_the_route_is_refused() {
        for value in [
            "",
            "..",
            "a/b",
            "../admin",
            "a?b=1",
            "a#k",
            "a%2Fb",
            "a b",
            "a.b",
            "é",
            &"a".repeat(MAX_LEN + 1),
        ] {
            assert!(matches!(segment(value), Err(AppError::Validation(_))), "{value:?}");
        }
    }
}
