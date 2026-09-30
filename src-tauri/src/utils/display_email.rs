//! Which emails the UI may show.
//!
//! Accounts that sign in without an email of their own (an access key or a
//! wallet) are given a system placeholder on the server, such as
//! `user_5hwk...@hippius.local`. It is not an address anyone can write to,
//! so it must never appear on screen. Every command that hands the frontend
//! an email for display passes it through [`display_email`], which drops the
//! placeholder the same way it drops a blank value: the field is absent and
//! the surface falls back to the name, then the shortened address.
//!
//! This is a display rule only. Nothing here touches what is stored or what
//! is sent to the server for auth. The frontend keeps a copy of the check
//! (`app/lib/utils/displayEmail.ts`) for emails that reach it another way;
//! `tests/fixtures/display_email_cases.json` pins the two together.

/// The domain the server gives placeholder emails.
pub const PLACEHOLDER_EMAIL_DOMAIN: &str = "hippius.local";

/// True for a system-generated placeholder: an address whose domain is
/// exactly `hippius.local`, ignoring case and surrounding whitespace.
pub fn is_placeholder_email(email: &str) -> bool {
    email
        .trim()
        .rsplit_once('@')
        .is_some_and(|(_, domain)| domain.eq_ignore_ascii_case(PLACEHOLDER_EMAIL_DOMAIN))
}

/// An email as the UI may show it: trimmed, and absent when blank or a
/// placeholder, so no surface draws an empty line or a fake address.
pub fn display_email(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty() && !is_placeholder_email(s))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        input: String,
        shown: Option<String>,
        note: String,
    }

    #[test]
    fn display_email_matches_shared_fixture() {
        let cases: Vec<Case> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/display_email_cases.json"
        )))
        .expect("display_email_cases.json is valid JSON");
        assert!(!cases.is_empty(), "fixture must carry cases");
        for case in &cases {
            assert_eq!(
                display_email(Some(&case.input)),
                case.shown,
                "display_email({:?}) - {}",
                case.input,
                case.note
            );
        }
    }

    #[test]
    fn an_absent_email_stays_absent() {
        assert_eq!(display_email(None), None);
    }

    #[test]
    fn the_placeholder_check_needs_the_exact_domain() {
        assert!(is_placeholder_email("user_x@hippius.local"));
        assert!(is_placeholder_email(" user_x@HIPPIUS.LOCAL "));
        assert!(!is_placeholder_email("user_x@hippius.localhost"));
        assert!(!is_placeholder_email("hippius.local"));
        assert!(!is_placeholder_email("ada@example.com"));
    }
}
