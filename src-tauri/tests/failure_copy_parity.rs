//! Source-text pins tying the Rust failure copy to the TypeScript copy.
//!
//! The same failure reaches the user down two paths that phrase it
//! independently. The live-event path renders Rust's
//! `FileFailureKindPayload::display_reason()`; the persisted-row path hands
//! the FE a bare `kind` and `app/lib/utils/failureMessage.ts` phrases it
//! there. Both surfaces are visible at once — a file table row and its
//! tooltip, say — so a drift shows up as the app contradicting itself.
//!
//! Several of these constants carry a comment saying they must stay
//! word-identical to their TS counterpart. Until this file, nothing enforced
//! it: changing either side (and only its own language's test) left the whole
//! suite green in both directions.
//!
//! Mirrors the `include_str!` wiring-pin convention used by
//! `folder_share_wiring.rs` and `chat_unread_wiring.rs`: the unit tests prove
//! each side phrases its own kind correctly, and these prove the two sides
//! still agree.

const FAILURE_MESSAGE_TS: &str = include_str!("../../app/lib/utils/failureMessage.ts");
const FILE_FAILURE_TS: &str = include_str!("../../app/lib/types/fileFailure.ts");
const EVENTS_RS: &str = include_str!("../src/sync/projection/events.rs");

/// Pull a `const NAME: &str = "…";` literal out of the Rust source.
///
/// Read from source text rather than linked in, so the pin survives the
/// constant being made private — and so a reader of this file can see exactly
/// what is being compared.
fn rust_const(name: &str) -> String {
    let anchor = format!("const {name}: &str =");
    let start = EVENTS_RS.find(&anchor).unwrap_or_else(|| panic!("{name} must exist in events.rs"));
    let rest = &EVENTS_RS[start + anchor.len()..];
    let open = rest.find('"').expect("literal must be a plain string");
    let after = &rest[open + 1..];
    let close = after.find('"').expect("literal must terminate");
    after[..close].to_string()
}

/// Pull an `export const NAME = "…";` literal out of the TS source.
///
/// The TS side hoists its copy to a const so the switch and the
/// reason-matching predicate cannot disagree; this reads that same const, so
/// the pin follows the single source rather than a duplicated literal.
fn ts_const(name: &str) -> String {
    let anchor = format!("export const {name} =");
    let start = FAILURE_MESSAGE_TS
        .find(&anchor)
        .unwrap_or_else(|| panic!("{name} must exist in failureMessage.ts"));
    let rest = &FAILURE_MESSAGE_TS[start + anchor.len()..];
    let open = rest.find('"').expect("literal must be a plain string");
    let after = &rest[open + 1..];
    let close = after.find('"').expect("literal must terminate");
    after[..close].to_string()
}

/// Every reason whose Rust definition claims parity with the FE.
///
/// Add a row when you add such a constant; the comment alone is not a
/// contract, which is the whole point of this file.
fn pinned_reasons() -> Vec<(&'static str, &'static str)> {
    vec![
        ("UNDECRYPTABLE_DISPLAY_REASON", "undecryptable"),
        ("NETWORK_DISPLAY_REASON", "network"),
        ("GONE_DISPLAY_REASON", "gone"),
        ("SESSION_LIMIT_DISPLAY_REASON", "session-limit 429"),
        ("QUOTA_DENIED_DISPLAY_REASON", "storage-quota 402"),
    ]
}

#[test]
fn every_pinned_rust_reason_appears_verbatim_in_the_typescript_copy() {
    for (name, context) in pinned_reasons() {
        let reason = rust_const(name);
        assert!(!reason.trim().is_empty(), "{name} must be a non-empty literal");
        assert!(
            FAILURE_MESSAGE_TS.contains(&reason),
            "{name} ({context}) reads {reason:?} in Rust but that sentence is \
             absent from app/lib/utils/failureMessage.ts. The live-event path \
             renders the Rust string and the persisted-row path renders the TS \
             one, so the app would phrase the same failure two ways. Update \
             both or neither."
        );
    }
}

/// The copy for a quarantined file must not promise a retry, on EITHER side.
///
/// hcfs stops fetching the file after two failed attempts on the same
/// revision, so "will retry" / "try again" would be telling the user to wait
/// for something that never happens. Asserted here rather than only in each
/// language's own test so it cannot be satisfied on one side alone.
#[test]
fn the_undecryptable_copy_promises_no_retry_in_either_language() {
    let reason = rust_const("UNDECRYPTABLE_DISPLAY_REASON");
    let lowered = reason.to_lowercase();
    assert!(
        !lowered.contains("retry") && !lowered.contains("try again"),
        "the Rust copy must not promise a retry: {reason}"
    );

    let ts_copy = ts_const("UNDECRYPTABLE_MESSAGE");
    let ts_lowered = ts_copy.to_lowercase();
    assert!(
        !ts_lowered.contains("retry") && !ts_lowered.contains("try again"),
        "the TypeScript copy must not promise a retry either: {ts_copy}"
    );
    assert_eq!(
        ts_copy, reason,
        "the two sides must phrase it identically — they render on different \
         surfaces and a user can see both at once"
    );
}

/// A kind the Rust side can emit but the FE union does not name falls through
/// to the FE's `default` branch and reads as the generic line — which is how
/// the `Decryption` bump regressed in the first place.
#[test]
fn the_undecryptable_kind_is_named_in_the_frontend_union() {
    assert!(
        FILE_FAILURE_TS.contains("\"undecryptable\""),
        "app/lib/types/fileFailure.ts must name the kind, or the FE switch \
         degrades it to the generic `other` branch"
    );
}
