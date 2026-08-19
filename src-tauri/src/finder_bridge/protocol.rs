//! Pure, sans-io line codec for the Finder-extension wire protocol.
//!
//! The extension and the app exchange one message per line over a local
//! transport (Unix-domain socket on macOS/Linux, named pipe on Windows). This
//! module is the codec ONLY — no sockets, no async (axiom `rust_quality_127`:
//! keep the protocol a synchronous core the I/O layer drives), so every CI
//! `rust` job exercises every parse/format path. The only platform-specific
//! part is the `OsStr` ↔ byte boundary ([`os_str_to_bytes`] /
//! [`bytes_to_os_string`]); the percent codec itself is pure bytes.
//!
//! ## Why paths are percent-encoded
//! A POSIX filename may contain any byte except `/` (0x2F) and NUL (0x00) —
//! including `:` and `\n`. A line protocol that pasted a raw path after the
//! verb would break framing on a newline inside a filename and mis-split on a
//! `:`. So the verb/argument split is on the FIRST `:` only (the path may then
//! contain further `:` bytes freely), and the path bytes are percent-encoded
//! to printable ASCII — escaping `%`, control bytes, 0x7F, and every byte
//! ≥0x80. The encoding is a bijection over arbitrary byte strings (proptest
//! `client_message_round_trips`), so any real path survives the round trip
//! exactly, including non-UTF-8 names.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// Badge a path should display in Finder. The app pushes these to the
/// extension; `Clear` removes any existing badge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadgeState {
    /// Fully synced — local and remote agree.
    Synced,
    /// Transfer in progress for this path.
    Syncing,
    /// A share link currently exists for this path.
    Shared,
    /// Remove any badge previously set on this path.
    Clear,
}

impl BadgeState {
    /// The lowercase wire token for this state.
    fn token(self) -> &'static str {
        match self {
            BadgeState::Synced => "synced",
            BadgeState::Syncing => "syncing",
            BadgeState::Shared => "shared",
            BadgeState::Clear => "clear",
        }
    }

    fn from_token(token: &str) -> Result<Self, ProtocolError> {
        match token {
            "synced" => Ok(BadgeState::Synced),
            "syncing" => Ok(BadgeState::Syncing),
            "shared" => Ok(BadgeState::Shared),
            "clear" => Ok(BadgeState::Clear),
            other => Err(ProtocolError::UnknownState(other.to_string())),
        }
    }
}

/// A message the Finder extension sends to the app — always a user menu action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientMessage {
    /// "Share with Hippius" on any clicked path. The verb carries only the
    /// *intent* to share — NOT the public/private choice, which now lives in the
    /// app: the desktop opens its share chooser (Anyone-with-the-link vs
    /// Password-protected) and mints only once the user confirms. The app also
    /// re-derives in-drive/outside and file/folder from the path, so this one
    /// verb covers every target and both visibilities (Google-Drive model — the
    /// decision moved out of Finder).
    Share(PathBuf),
}

impl ClientMessage {
    /// Encode to a single wire line (no trailing newline — framing is the
    /// socket layer's job).
    pub fn to_wire(&self) -> String {
        match self {
            ClientMessage::Share(path) => format!("SHARE:{}", encode_path(path)),
        }
    }

    /// Parse one wire line (without its terminating newline). Only `SHARE` is
    /// recognized now; the retired `UPLOAD_SHARE` / `SHARE_PRIVATE` verbs fall
    /// through to [`ProtocolError::UnknownVerb`] (a stale extension binary that
    /// still sends them is safely ignored rather than mis-dispatched).
    pub fn parse(line: &str) -> Result<Self, ProtocolError> {
        let (verb, rest) = split_verb(line)?;
        match verb {
            "SHARE" => Ok(ClientMessage::Share(decode_path(rest)?)),
            other => Err(ProtocolError::UnknownVerb(other.to_string())),
        }
    }
}

/// A message the app sends to the Finder extension.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerMessage {
    /// Start monitoring a Hippius sync root (drive added / login).
    RegisterPath(PathBuf),
    /// Stop monitoring a sync root (drive removed).
    UnregisterPath(PathBuf),
    /// Set (or clear) the badge for a single path.
    Status {
        /// The badge to paint.
        state: BadgeState,
        /// The path the badge applies to.
        path: PathBuf,
    },
}

impl ServerMessage {
    /// Encode to a single wire line (no trailing newline).
    pub fn to_wire(&self) -> String {
        match self {
            ServerMessage::RegisterPath(path) => format!("REGISTER_PATH:{}", encode_path(path)),
            ServerMessage::UnregisterPath(path) => format!("UNREGISTER_PATH:{}", encode_path(path)),
            ServerMessage::Status { state, path } => {
                format!("STATUS:{}:{}", state.token(), encode_path(path))
            }
        }
    }

    /// Parse one wire line (without its terminating newline).
    pub fn parse(line: &str) -> Result<Self, ProtocolError> {
        let (verb, rest) = split_verb(line)?;
        match verb {
            "REGISTER_PATH" => Ok(ServerMessage::RegisterPath(decode_path(rest)?)),
            "UNREGISTER_PATH" => Ok(ServerMessage::UnregisterPath(decode_path(rest)?)),
            "STATUS" => {
                // The state token has no `:`, so the first `:` separates it
                // from the (possibly `:`-containing) encoded path.
                let (token, encoded) = rest.split_once(':').ok_or(ProtocolError::Malformed { verb: "STATUS" })?;
                Ok(ServerMessage::Status {
                    state: BadgeState::from_token(token)?,
                    path: decode_path(encoded)?,
                })
            }
            other => Err(ProtocolError::UnknownVerb(other.to_string())),
        }
    }
}

/// Failure parsing a wire line. A typed `#[non_exhaustive]` enum per the
/// project's error discipline (mirrors `vpn/error.rs`); the socket task wires
/// it into [`crate::error::AppError`] via `#[from]` when it first crosses a
/// Tauri boundary.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProtocolError {
    /// The line was empty.
    #[error("empty protocol line")]
    Empty,
    /// The line carried no `verb:` separator.
    #[error("protocol line has no verb separator")]
    NoSeparator,
    /// The verb is not one this codec knows.
    #[error("unknown protocol verb: {0}")]
    UnknownVerb(String),
    /// A known verb's payload was structurally wrong (e.g. STATUS without a state).
    #[error("malformed {verb} message")]
    Malformed {
        /// The verb whose payload was malformed.
        verb: &'static str,
    },
    /// A `STATUS` badge token was not one of the known states.
    #[error("unknown badge state: {0}")]
    UnknownState(String),
    /// A percent-escape in the path was truncated or non-hex.
    #[error("invalid percent-encoding in path")]
    BadEncoding,
}

/// Split a line into `(verb, rest)` on the FIRST `:`. The rest may itself
/// contain `:` (an encoded path can), so only the verb boundary is consumed.
fn split_verb(line: &str) -> Result<(&str, &str), ProtocolError> {
    if line.is_empty() {
        return Err(ProtocolError::Empty);
    }
    line.split_once(':').ok_or(ProtocolError::NoSeparator)
}

/// Percent-encode a path's raw bytes to printable ASCII. Literal bytes are
/// `0x20..=0x7E` except `%`; every other byte (controls, `0x7F`, `≥0x80`, and
/// `%` itself) becomes `%XX`. Reversible for any byte string — see
/// [`decode_path`].
fn encode_path(path: &Path) -> String {
    let bytes = os_str_to_bytes(path.as_os_str());
    let mut out = String::with_capacity(bytes.len());
    for &byte in &bytes {
        if (0x20..=0x7E).contains(&byte) && byte != b'%' {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(hex_digit(byte >> 4));
            out.push(hex_digit(byte & 0x0F));
        }
    }
    out
}

/// Inverse of [`encode_path`]. Bytes outside an escape pass through verbatim,
/// so a literal `:` in the encoded path is preserved.
fn decode_path(encoded: &str) -> Result<PathBuf, ProtocolError> {
    let bytes = encoded.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            // Need two more bytes for the hex pair.
            if i + 2 >= bytes.len() {
                return Err(ProtocolError::BadEncoding);
            }
            let hi = hex_value(bytes[i + 1]).ok_or(ProtocolError::BadEncoding)?;
            let lo = hex_value(bytes[i + 2]).ok_or(ProtocolError::BadEncoding)?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Ok(PathBuf::from(bytes_to_os_string(out)?))
}

/// Lossless `OsStr` → raw wire bytes. The percent codec above is a pure byte
/// transform, so this boundary is the ONLY platform-specific part of the
/// protocol.
///
/// - **Unix:** an OS string already *is* a byte sequence — identity.
/// - **Windows:** an OS string is a sequence of (possibly ill-formed) UTF-16
///   code units; each is serialized little-endian, which [`bytes_to_os_string`]
///   reverses via `OsString::from_wide`. This is lossless for any real path.
///
/// The Windows wire bytes for a given string differ from the Unix ones — which
/// is irrelevant: the Finder/Explorer extension and the app are always the same
/// OS, so only a *per-platform* round trip is required, never cross-OS wire
/// compatibility.
#[cfg(unix)]
fn os_str_to_bytes(s: &OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    s.as_bytes().to_vec()
}

#[cfg(windows)]
fn os_str_to_bytes(s: &OsStr) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    let mut out = Vec::new();
    for unit in s.encode_wide() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

/// Inverse of [`os_str_to_bytes`].
///
/// # Errors
/// On Windows an odd-length byte run cannot be regrouped into UTF-16 code units,
/// so it yields [`ProtocolError::BadEncoding`] — the same shape as a truncated
/// percent-escape. On Unix any byte sequence is a valid `OsString`, so this is
/// infallible there (the `Result` is uniform across platforms).
#[cfg(unix)]
fn bytes_to_os_string(bytes: Vec<u8>) -> Result<OsString, ProtocolError> {
    use std::os::unix::ffi::OsStringExt;
    Ok(OsString::from_vec(bytes))
}

#[cfg(windows)]
fn bytes_to_os_string(bytes: Vec<u8>) -> Result<OsString, ProtocolError> {
    use std::os::windows::ffi::OsStringExt;
    if bytes.len() % 2 != 0 {
        return Err(ProtocolError::BadEncoding);
    }
    let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
    Ok(OsString::from_wide(&units))
}

/// Map a nibble (0..=15) to its uppercase hex digit.
fn hex_digit(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'A' + (nibble - 10)) as char,
    }
}

/// Map an ASCII hex digit byte to its value, accepting both cases.
fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    // Byte-level `OsString` construction is platform-specific; each round-trip
    // test that builds a raw non-UTF-8/UTF-16 path pulls in the matching trait.
    #[cfg(unix)]
    use std::os::unix::ffi::OsStringExt;
    #[cfg(windows)]
    use std::os::windows::ffi::OsStringExt;

    #[test]
    fn client_share_round_trips_with_colon_and_space() {
        let m = ClientMessage::Share(PathBuf::from("/Users/x/My: Notes/a b.txt"));
        assert_eq!(ClientMessage::parse(&m.to_wire()), Ok(m));
    }

    #[test]
    fn retired_verbs_are_now_unknown() {
        // The public/private + upload distinctions collapsed into the single
        // SHARE verb (the app decides visibility and re-resolves the target). A
        // stale extension binary still emitting the old verbs must be rejected,
        // not silently mapped onto a share — pin that they no longer parse.
        assert_eq!(
            ClientMessage::parse("UPLOAD_SHARE:/tmp/outside.pdf"),
            Err(ProtocolError::UnknownVerb("UPLOAD_SHARE".into()))
        );
        assert_eq!(
            ClientMessage::parse("SHARE_PRIVATE:/x"),
            Err(ProtocolError::UnknownVerb("SHARE_PRIVATE".into()))
        );
    }

    #[test]
    fn status_round_trips_with_colon_in_path() {
        let m = ServerMessage::Status {
            state: BadgeState::Syncing,
            path: PathBuf::from("/a:b/c"),
        };
        assert_eq!(ServerMessage::parse(&m.to_wire()), Ok(m));
    }

    #[test]
    fn register_unregister_round_trip() {
        for m in [
            ServerMessage::RegisterPath(PathBuf::from("/Users/me/Hippius")),
            ServerMessage::UnregisterPath(PathBuf::from("/Users/me/Hippius")),
        ] {
            assert_eq!(ServerMessage::parse(&m.to_wire()), Ok(m));
        }
    }

    #[test]
    fn newline_in_path_is_escaped_and_recovered() {
        let weird = PathBuf::from("/tmp/a\nb");
        let wire = ClientMessage::Share(weird.clone()).to_wire();
        assert!(!wire.contains('\n'), "encoded line must not contain a raw newline");
        assert_eq!(ClientMessage::parse(&wire), Ok(ClientMessage::Share(weird)));
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_path_round_trips() {
        // A POSIX path need not be valid UTF-8.
        let path = PathBuf::from(OsString::from_vec(vec![b'/', 0xFF, 0xFE, b'x']));
        let wire = ServerMessage::RegisterPath(path.clone()).to_wire();
        assert!(wire.is_ascii(), "encoded wire must be pure ASCII");
        assert_eq!(ServerMessage::parse(&wire), Ok(ServerMessage::RegisterPath(path)));
    }

    /// The Windows analog: an OS string may be ill-formed UTF-16 (an unpaired
    /// surrogate like `0xD800`). The `encode_wide` → u16-LE boundary must still
    /// round-trip it exactly and keep the wire pure ASCII.
    #[cfg(windows)]
    #[test]
    fn ill_formed_utf16_path_round_trips() {
        let path = PathBuf::from(OsString::from_wide(&[0x0043, 0x003A, 0x005C, 0xD800, 0x0078]));
        let wire = ServerMessage::RegisterPath(path.clone()).to_wire();
        assert!(wire.is_ascii(), "encoded wire must be pure ASCII");
        assert_eq!(ServerMessage::parse(&wire), Ok(ServerMessage::RegisterPath(path)));
    }

    /// A Windows backslash path with a space round-trips through the same codec
    /// (the common real case the Explorer extension forwards).
    #[cfg(windows)]
    #[test]
    fn windows_backslash_path_round_trips() {
        let m = ClientMessage::Share(PathBuf::from(r"C:\Users\x\My Docs\a.txt"));
        assert_eq!(ClientMessage::parse(&m.to_wire()), Ok(m));
    }

    /// An odd-length decoded byte run can't regroup into UTF-16 units on
    /// Windows, so decoding rejects it rather than silently dropping the tail.
    #[cfg(windows)]
    #[test]
    fn windows_odd_length_bytes_rejected() {
        // Three raw bytes (one-and-a-half u16s) after the verb.
        assert_eq!(ClientMessage::parse("SHARE:%00%01%02"), Err(ProtocolError::BadEncoding));
    }

    #[test]
    fn empty_line_is_empty_error() {
        assert_eq!(ClientMessage::parse(""), Err(ProtocolError::Empty));
    }

    #[test]
    fn line_without_separator_rejected() {
        assert_eq!(ClientMessage::parse("SHARE"), Err(ProtocolError::NoSeparator));
    }

    #[test]
    fn unknown_verb_rejected() {
        assert_eq!(ClientMessage::parse("BOGUS:/x"), Err(ProtocolError::UnknownVerb("BOGUS".into())));
        assert_eq!(ServerMessage::parse("BOGUS:/x"), Err(ProtocolError::UnknownVerb("BOGUS".into())));
    }

    #[test]
    fn truncated_or_nonhex_percent_escape_rejected() {
        assert_eq!(ClientMessage::parse("SHARE:/x%"), Err(ProtocolError::BadEncoding));
        assert_eq!(ClientMessage::parse("SHARE:/x%2"), Err(ProtocolError::BadEncoding));
        assert_eq!(ClientMessage::parse("SHARE:/x%ZZ"), Err(ProtocolError::BadEncoding));
    }

    #[test]
    fn unknown_badge_state_rejected() {
        assert_eq!(ServerMessage::parse("STATUS:bogus:/x"), Err(ProtocolError::UnknownState("bogus".into())));
    }

    #[test]
    fn status_without_state_is_malformed() {
        // A STATUS line needs `state:path`; with no second `:` there is no
        // state/path boundary at all, so it is structurally malformed rather
        // than an "unknown state" (which requires a parsed-but-bad token).
        assert_eq!(ServerMessage::parse("STATUS:onlypath"), Err(ProtocolError::Malformed { verb: "STATUS" }));
    }

    proptest! {
        // The path codec is a bijection over arbitrary byte strings (excluding
        // NUL, which no real POSIX path carries): format → parse recovers the
        // exact path. Unix-only because it builds paths from raw bytes.
        #[cfg(unix)]
        #[test]
        fn client_message_round_trips(bytes in proptest::collection::vec(1u8..=255, 0..64)) {
            let path = PathBuf::from(OsString::from_vec(bytes));
            let m = ClientMessage::Share(path);
            prop_assert_eq!(ClientMessage::parse(&m.to_wire()), Ok(m));
        }

        #[cfg(unix)]
        #[test]
        fn server_status_round_trips(bytes in proptest::collection::vec(1u8..=255, 0..64), which in 0u8..4) {
            let path = PathBuf::from(OsString::from_vec(bytes));
            let state = match which {
                0 => BadgeState::Synced,
                1 => BadgeState::Syncing,
                2 => BadgeState::Shared,
                _ => BadgeState::Clear,
            };
            let m = ServerMessage::Status { state, path };
            prop_assert_eq!(ServerMessage::parse(&m.to_wire()), Ok(m));
        }

        // Encoded output is always single-line printable ASCII — the framing
        // invariant the transport layer relies on.
        #[cfg(unix)]
        #[test]
        fn encoded_line_is_ascii_single_line(bytes in proptest::collection::vec(1u8..=255, 0..64)) {
            let wire = ClientMessage::Share(PathBuf::from(OsString::from_vec(bytes))).to_wire();
            prop_assert!(wire.is_ascii());
            prop_assert!(!wire.contains('\n') && !wire.contains('\r'));
        }
    }

    // The Windows analogs of the bijection + framing proptests: the codec is a
    // bijection over arbitrary UTF-16 code-unit strings (excluding the NUL unit,
    // which no real path carries) via the `encode_wide` ↔ u16-LE boundary, and
    // the wire stays single-line ASCII.
    #[cfg(windows)]
    proptest! {
        #[test]
        fn windows_message_round_trips(units in proptest::collection::vec(1u16..=u16::MAX, 0..64)) {
            let path = PathBuf::from(OsString::from_wide(&units));
            let m = ClientMessage::Share(path);
            prop_assert_eq!(ClientMessage::parse(&m.to_wire()), Ok(m));
        }

        #[test]
        fn windows_encoded_line_is_ascii_single_line(units in proptest::collection::vec(1u16..=u16::MAX, 0..64)) {
            let wire = ClientMessage::Share(PathBuf::from(OsString::from_wide(&units))).to_wire();
            prop_assert!(wire.is_ascii());
            prop_assert!(!wire.contains('\n') && !wire.contains('\r'));
        }
    }
}
