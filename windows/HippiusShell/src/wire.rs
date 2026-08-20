//! The bridge wire format + pipe name, mirrored from the desktop app's
//! `finder_bridge::protocol` and `finder_bridge::endpoint` (their Windows arms).
//!
//! This small duplication avoids depending on the whole `src-tauri` crate from
//! the shell extension. A shared `finder-wire` crate both sides depend on is the
//! eventual dedup; until then the KATs in `tests` pin the format so a drift in
//! either copy is caught (they must equal what `socket.rs`'s server parses).
//!
//! Windows encoding (must match `protocol.rs::os_str_to_bytes` + `encode_path`):
//! the `OsStr` is serialized as little-endian UTF-16 code units, then EACH byte
//! is percent-encoded — printable ASCII `0x20..=0x7E` except `%` passes through,
//! everything else becomes `%XX` (uppercase hex). So an ASCII char emits its low
//! byte literally followed by `%00` for the high byte.

#![cfg(windows)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

/// The named pipe the running app serves, scoped per user. MUST match
/// `finder_bridge::endpoint::resolve()`'s Windows arm byte-for-byte, or the
/// extension writes to a pipe the app never created.
pub fn pipe_name_for_current_user() -> String {
    let raw = std::env::var("USERNAME").unwrap_or_default();
    let user: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    let user = if user.is_empty() { "default".to_string() } else { user };
    format!(r"\\.\pipe\hippius-finder-{user}")
}

/// Build the `SHARE:<encoded>` wire line (NO trailing newline — the caller adds
/// it) for `path`, matching `ClientMessage::Share(path).to_wire()` on Windows.
pub fn share_line(path: &OsStr) -> String {
    let mut out = String::from("SHARE:");
    for unit in path.encode_wide() {
        for byte in unit.to_le_bytes() {
            encode_byte(byte, &mut out);
        }
    }
    out
}

/// Percent-encode one byte into `out` (see the module-level contract).
fn encode_byte(byte: u8, out: &mut String) {
    if (0x20..=0x7E).contains(&byte) && byte != b'%' {
        out.push(byte as char);
    } else {
        out.push('%');
        out.push(hex_digit(byte >> 4));
        out.push(hex_digit(byte & 0x0F));
    }
}

/// Map a nibble (0..=15) to its uppercase hex digit.
fn hex_digit(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'A' + (nibble - 10)) as char,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    /// Known-answer, byte-for-byte equal to what `protocol.rs` emits on Windows
    /// for the same path. `'C'` (U+0043) → low byte 0x43 (printable → `C`) then
    /// high byte 0x00 (`%00`); `':'` (U+003A) → 0x3A (printable → `:`) then
    /// `%00`. A break here means the extension and the app copy have drifted.
    #[test]
    fn ascii_path_kat() {
        assert_eq!(share_line(&OsString::from("C:")), "SHARE:C%00:%00");
    }

    /// Backslash (0x5C) and space (0x20) are both printable ASCII, so they stay
    /// literal; only the 0x00 high bytes are escaped. (Raw string so the literal
    /// backslash isn't a Rust escape.)
    #[test]
    fn backslash_and_space_stay_literal() {
        let path = OsString::from_wide(&[0x005C, 0x0020, 0x0061]); // \ space a
        assert_eq!(share_line(&path), r"SHARE:\%00 %00a%00");
    }

    /// A non-ASCII BMP unit (é = U+00E9) escapes both bytes: 0xE9 then 0x00.
    #[test]
    fn non_ascii_unit_escapes_both_bytes() {
        let path = OsString::from_wide(&[0x00E9]);
        assert_eq!(share_line(&path), "SHARE:%E9%00");
    }

    #[test]
    fn pipe_name_is_user_scoped() {
        assert!(pipe_name_for_current_user().starts_with(r"\\.\pipe\hippius-finder-"));
    }
}
