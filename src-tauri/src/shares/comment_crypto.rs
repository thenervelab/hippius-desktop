//! Encryption of share-link comments and viewer names.
//!
//! Comments on a shared screenshot or recording are end-to-end encrypted:
//! the server stores ciphertext and a nonce and cannot read either the text
//! or the name a viewer chose to show. This is a cross-client contract with
//! the web console, which writes them; both are tested against the same
//! fixed vectors (`tests/fixtures/share_comments_vectors.json`), so a change
//! on either side that would make the other unable to read a comment fails
//! a test.
//!
//! - Key: `HKDF-SHA256(ikm = the 32-byte share key, salt = empty,
//!   info = "hippius-share-comments-v1", L = 32)`.
//! - Cipher: AES-256-GCM, 12-byte nonce, the 16-byte tag appended to the
//!   ciphertext.
//! - Additional data binds a ciphertext to its link and its purpose:
//!   `<token>:comment` or `<token>:viewer-name`, so a ciphertext copied onto
//!   another share, or a comment passed off as a name, fails to open.
//! - Plaintext: `{"text": ..., "name": ... | null}` for a comment,
//!   `{"name": ...}` for a viewer name.
//!
//! The share key is the link's own key (`#k=`), which the owner gets back
//! from this device's keystore or its owner wrap. A password link's key is
//! wrapped by a password nobody stores, so its comments cannot be read here.

use std::sync::LazyLock;

use base64::Engine;
use hkdf::Hkdf;
use regex::Regex;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

/// The HKDF `info` both clients use.
pub const COMMENT_KEY_INFO: &[u8] = b"hippius-share-comments-v1";
/// AES-GCM nonce length.
pub const NONCE_LEN: usize = 12;
/// AES-GCM tag length, appended to the ciphertext.
pub const TAG_LEN: usize = 16;

/// What a ciphertext is for: part of its additional data, so one cannot be
/// read as the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Comment,
    ViewerName,
}

impl Purpose {
    fn suffix(self) -> &'static str {
        match self {
            Self::Comment => "comment",
            Self::ViewerName => "viewer-name",
        }
    }
}

/// The additional data for a ciphertext on link `token`.
#[must_use]
pub fn aad(token: &str, purpose: Purpose) -> Vec<u8> {
    format!("{token}:{}", purpose.suffix()).into_bytes()
}

/// A comment key, wiped on drop.
pub struct CommentKey(Zeroizing<[u8; 32]>);

impl CommentKey {
    /// Derive the comment key from a link's 32-byte share key.
    #[must_use]
    pub fn derive(share_key: &[u8; 32]) -> Self {
        // An empty salt, as both clients use. (RFC 5869 pads an absent or
        // empty salt with zeros, so `None` and `Some(&[])` agree.)
        let hk = Hkdf::<Sha256>::new(Some(&[]), share_key);
        let mut okm = Zeroizing::new([0u8; 32]);
        hk.expand(COMMENT_KEY_INFO, okm.as_mut()).expect("32 bytes is a valid HKDF-SHA256 length");
        Self(okm)
    }

    fn aead(&self) -> LessSafeKey {
        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, self.0.as_ref()).expect("a 32-byte key fits AES-256"))
    }

    #[cfg(test)]
    fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Why a ciphertext did not open. Never carries any of the bytes.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpenError {
    #[error("not base64")]
    Encoding,
    #[error("nonce has the wrong length")]
    Nonce,
    #[error("did not decrypt")]
    Decrypt,
    #[error("not the expected JSON")]
    Shape,
}

/// Decode base64 the way either client might have written it: standard or
/// URL-safe alphabet, with or without padding.
pub fn decode_b64(s: &str) -> Result<Vec<u8>, OpenError> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    let s = s.trim();
    [STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD]
        .iter()
        .find_map(|engine| engine.decode(s).ok())
        .ok_or(OpenError::Encoding)
}

/// Open `ciphertext` (tag appended) with `nonce` for `purpose` on `token`.
///
/// # Errors
///
/// [`OpenError`] when the nonce is malformed or the ciphertext does not
/// authenticate (wrong key, wrong link, wrong purpose, tampered).
pub fn open(key: &CommentKey, token: &str, purpose: Purpose, nonce: &[u8], ciphertext: &[u8]) -> Result<Zeroizing<Vec<u8>>, OpenError> {
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| OpenError::Nonce)?;
    if ciphertext.len() < TAG_LEN {
        return Err(OpenError::Decrypt);
    }
    let mut buf = Zeroizing::new(ciphertext.to_vec());
    let len = key
        .aead()
        .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::from(aad(token, purpose)), buf.as_mut())
        .map_err(|_| OpenError::Decrypt)?
        .len();
    buf.truncate(len);
    Ok(buf)
}

/// Seal `plaintext` with a given nonce. Only the tests use it (the desktop
/// never writes comments; viewers do, on the console's share page), to prove
/// the scheme byte for byte against the shared vectors.
///
/// # Errors
///
/// When the nonce is not 12 bytes.
pub fn seal_with_nonce(key: &CommentKey, token: &str, purpose: Purpose, nonce: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, OpenError> {
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| OpenError::Nonce)?;
    let mut buf = plaintext.to_vec();
    key.aead()
        .seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad(token, purpose)), &mut buf)
        .map_err(|_| OpenError::Decrypt)?;
    Ok(buf)
}

/// A decrypted comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentPlaintext {
    pub text: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Deserialize)]
struct NamePlaintext {
    name: String,
}

/// Open a comment from its base64 nonce and ciphertext.
///
/// # Errors
///
/// As [`open`], plus [`OpenError::Shape`] when the plaintext is not the
/// comment JSON.
pub fn open_comment(key: &CommentKey, token: &str, nonce_b64: &str, ciphertext_b64: &str) -> Result<CommentPlaintext, OpenError> {
    let plain = open(key, token, Purpose::Comment, &decode_b64(nonce_b64)?, &decode_b64(ciphertext_b64)?)?;
    let mut comment: CommentPlaintext = serde_json::from_slice(&plain).map_err(|_| OpenError::Shape)?;
    comment.name = clean_name(comment.name.as_deref());
    Ok(comment)
}

/// Open a viewer's name from its base64 nonce and ciphertext. `None` for a
/// name that would show as nothing (see [`clean_name`]).
///
/// # Errors
///
/// As [`open_comment`].
pub fn open_viewer_name(key: &CommentKey, token: &str, nonce_b64: &str, ciphertext_b64: &str) -> Result<Option<String>, OpenError> {
    let plain = open(key, token, Purpose::ViewerName, &decode_b64(nonce_b64)?, &decode_b64(ciphertext_b64)?)?;
    let parsed: NamePlaintext = serde_json::from_slice(&plain).map_err(|_| OpenError::Shape)?;
    Ok(clean_name(Some(&parsed.name)))
}

/// The longest name kept, in characters (code points, as the console's
/// `Array.from` counts them). It must equal the console's `MAX_NAME_CHARS`:
/// the blank check runs on what is left after the cut, so a different limit
/// would make the two clients disagree on which names are blank.
const MAX_NAME_CHARS: usize = 80;

/// A name of nothing but code points that draw nothing on their own:
/// whitespace, control characters, format characters (zero-width space,
/// ZWNJ, ZWJ, word joiner, BOM, bidi marks, soft hyphen, tags), other
/// default-ignorables (variation selectors, Hangul fillers), and the braille blank,
/// a common way to fake an empty name. The Arabic, Syriac and Kaithi
/// prepended concatenation marks are format characters that draw a glyph, so
/// they are taken out of the set.
///
/// This is the console's `INVISIBLE_ONLY` (`comment-crypto.ts`), written with
/// set subtraction where the console needs a lookahead. Each side takes its
/// Unicode tables from its own engine (the `regex` crate here, the browser's
/// ICU there), so a code point assigned in a newer Unicode version can be
/// judged differently until both catch up.
static INVISIBLE_ONLY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^[",
        r"[\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\x{2800}]",
        r"--[\x{600}-\x{605}\x{6DD}\x{70F}\x{890}\x{891}\x{8E2}\x{110BD}\x{110CD}]",
        r"]*$",
    ))
    .expect("a fixed pattern of supported Unicode classes")
});

/// True when a name would show as nothing. Only this check treats joiners as
/// invisible: a name with anything visible keeps them, so ZWJ emoji and ZWNJ
/// in Persian or Indic names stay intact.
fn is_blank_name(name: &str) -> bool {
    INVISIBLE_ONLY.is_match(name)
}

/// What ECMAScript's `String.prototype.trim` removes: `White_Space` without
/// U+0085, plus U+FEFF. The console trims before it cuts, so trimming
/// anything else here would count characters differently toward the limit.
fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

/// Characters a visible name cannot show as typed: controls, line and
/// paragraph separators, and bidi marks, embeddings, overrides and isolates,
/// which can make a name read as something it is not, break its row, or
/// reorder the rest of it. The console does not touch these; it only matters
/// that every one of them is invisible by [`is_blank_name`], so replacing
/// them never changes whether a name is blank.
fn is_display_unsafe(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{2028}' | '\u{2029}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
        )
}

/// How one character of a visible name is shown. Unsafe whitespace (tab,
/// newline, line separator) becomes a space so the words it separated stay
/// apart, as the console's page shows them; other unsafe characters go.
fn shown_char(c: char) -> Option<char> {
    match (is_display_unsafe(c), c.is_whitespace()) {
        (false, _) => Some(c),
        (true, true) => Some(' '),
        (true, false) => None,
    }
}

/// A viewer-chosen name made safe to show, or `None` when it would show as
/// nothing.
///
/// Trimmed, cut to [`MAX_NAME_CHARS`] and trimmed at the end exactly as the
/// console does, then judged blank on what is left, so visible text past the
/// limit cannot keep an otherwise invisible name alive. A visible name is
/// kept as typed, except that [`is_display_unsafe`] characters are replaced
/// by [`shown_char`] and the result is trimmed again.
fn clean_name(name: Option<&str>) -> Option<String> {
    let kept: String = name?.trim_matches(is_js_whitespace).chars().take(MAX_NAME_CHARS).collect();
    let kept = kept.trim_end_matches(is_js_whitespace);
    if is_blank_name(kept) {
        return None;
    }

    let shown: String = kept.chars().filter_map(shown_char).collect();
    Some(shown.trim_matches(is_js_whitespace).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[derive(Deserialize)]
    struct Fixture {
        share_key_hex: String,
        share_key_b64url: String,
        token: String,
        comment_key_hex: String,
        vectors: Vec<Vector>,
        names: NameVectors,
    }

    /// The name-cleaning rule both clients apply, as cases each one runs.
    #[derive(Deserialize)]
    struct NameVectors {
        max_chars: usize,
        blank: Vec<NameCase>,
        visible: Vec<NameCase>,
        cleaned: Vec<CleanedCase>,
    }

    #[derive(Deserialize)]
    struct NameCase {
        label: String,
        name: String,
    }

    #[derive(Deserialize)]
    struct CleanedCase {
        label: String,
        name: String,
        cleaned: String,
    }

    #[derive(Deserialize)]
    struct Vector {
        kind: String,
        aad: String,
        nonce_b64: String,
        plaintext: String,
        ciphertext_b64: String,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/share_comments_vectors.json"
        )))
        .expect("the shared vectors are valid JSON")
    }

    fn hex(bytes: &[u8]) -> String {
        use std::fmt::Write as _;
        bytes.iter().fold(String::new(), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
    }

    fn share_key(f: &Fixture) -> [u8; 32] {
        let key = decode_b64(&f.share_key_b64url).unwrap();
        assert_eq!(hex(&key), f.share_key_hex, "the fixture's two spellings of the share key agree");
        key.try_into().unwrap()
    }

    fn purpose_of(kind: &str) -> Purpose {
        if kind == "viewer-name" { Purpose::ViewerName } else { Purpose::Comment }
    }

    #[test]
    fn the_comment_key_matches_the_console() {
        let f = fixture();
        let key = CommentKey::derive(&share_key(&f));
        assert_eq!(hex(key.bytes()), f.comment_key_hex);
    }

    /// Every shared vector opens to its plaintext, with the additional data
    /// the fixture names.
    #[test]
    fn every_shared_vector_decrypts() {
        let f = fixture();
        let key = CommentKey::derive(&share_key(&f));
        assert_eq!(f.vectors.len(), 3, "comment, anonymous comment and viewer name");
        for v in &f.vectors {
            let purpose = purpose_of(&v.kind);
            assert_eq!(aad(&f.token, purpose), v.aad.as_bytes(), "{}: additional data", v.kind);
            let plain = open(
                &key,
                &f.token,
                purpose,
                &decode_b64(&v.nonce_b64).unwrap(),
                &decode_b64(&v.ciphertext_b64).unwrap(),
            )
            .unwrap_or_else(|e| panic!("{}: {e}", v.kind));
            assert_eq!(std::str::from_utf8(&plain).unwrap(), v.plaintext, "{}", v.kind);
        }
    }

    /// Sealing the vectors' plaintexts with their fixed nonce gives their
    /// exact bytes, so the console reads what this side would write.
    #[test]
    fn sealing_with_the_fixed_nonce_gives_the_shared_ciphertext() {
        let f = fixture();
        let key = CommentKey::derive(&share_key(&f));
        for v in &f.vectors {
            let sealed = seal_with_nonce(
                &key,
                &f.token,
                purpose_of(&v.kind),
                &decode_b64(&v.nonce_b64).unwrap(),
                v.plaintext.as_bytes(),
            )
            .unwrap();
            assert_eq!(base64::engine::general_purpose::STANDARD.encode(sealed), v.ciphertext_b64, "{}", v.kind);
        }
    }

    #[test]
    fn comments_and_names_parse_from_the_vectors() {
        let f = fixture();
        let key = CommentKey::derive(&share_key(&f));
        let by_kind = |k: &str| f.vectors.iter().find(|v| v.kind == k).unwrap();

        let named = by_kind("comment");
        let c = open_comment(&key, &f.token, &named.nonce_b64, &named.ciphertext_b64).unwrap();
        assert_eq!(c.text, "Looks great at 1:23!");
        assert_eq!(c.name.as_deref(), Some("Ahmad"));

        let anon = by_kind("comment-anonymous");
        let c = open_comment(&key, &f.token, &anon.nonce_b64, &anon.ciphertext_b64).unwrap();
        assert_eq!(c.text, "Nice");
        assert_eq!(c.name, None);

        let name = by_kind("viewer-name");
        assert_eq!(
            open_viewer_name(&key, &f.token, &name.nonce_b64, &name.ciphertext_b64)
                .unwrap()
                .as_deref(),
            Some("Ahmad")
        );
    }

    /// The additional data is what stops a ciphertext from being moved: onto
    /// another link, or from a comment into a name.
    #[test]
    fn a_ciphertext_does_not_open_on_another_link_or_as_another_purpose() {
        let f = fixture();
        let key = CommentKey::derive(&share_key(&f));
        let v = f.vectors.iter().find(|v| v.kind == "comment").unwrap();
        let (nonce, ct) = (decode_b64(&v.nonce_b64).unwrap(), decode_b64(&v.ciphertext_b64).unwrap());
        assert_eq!(
            open(&key, "another-token", Purpose::Comment, &nonce, &ct).unwrap_err(),
            OpenError::Decrypt
        );
        assert_eq!(open(&key, &f.token, Purpose::ViewerName, &nonce, &ct).unwrap_err(), OpenError::Decrypt);
        let other = CommentKey::derive(&[7u8; 32]);
        assert_eq!(open(&other, &f.token, Purpose::Comment, &nonce, &ct).unwrap_err(), OpenError::Decrypt);
        let mut tampered = ct.clone();
        tampered[0] ^= 1;
        assert_eq!(open(&key, &f.token, Purpose::Comment, &nonce, &tampered).unwrap_err(), OpenError::Decrypt);
        assert_eq!(open(&key, &f.token, Purpose::Comment, &nonce[..8], &ct).unwrap_err(), OpenError::Nonce);
        assert_eq!(open(&key, &f.token, Purpose::Comment, &nonce, &ct[..4]).unwrap_err(), OpenError::Decrypt);
        assert_eq!(open_comment(&key, &f.token, "***", &v.ciphertext_b64).unwrap_err(), OpenError::Encoding);
    }

    #[test]
    fn base64_is_read_in_any_spelling() {
        let bytes = [0xfbu8, 0xff, 0xfe, 0x01];
        for s in ["+//+AQ==", "+//+AQ", "-__-AQ==", "-__-AQ"] {
            assert_eq!(decode_b64(s).unwrap(), bytes, "{s}");
        }
    }

    /// A name a viewer typed cannot pose as something else in the list.
    #[test]
    fn names_are_cleaned_before_they_are_shown() {
        assert_eq!(clean_name(Some("  Ahmad  ")).as_deref(), Some("Ahmad"));
        assert_eq!(clean_name(Some("Bob\u{202E}nimda")).as_deref(), Some("Bobnimda"));
        assert_eq!(clean_name(Some("\u{202E} Bob\t")).as_deref(), Some("Bob"));
        assert_eq!(clean_name(Some("Bob\tAdmin")).as_deref(), Some("Bob Admin"));
        assert_eq!(clean_name(Some("Bob\u{2028}Admin\n")).as_deref(), Some("Bob Admin"));
        assert_eq!(clean_name(Some("\u{200B}\n ")), None);
        assert_eq!(clean_name(None), None);
        assert_eq!(clean_name(Some(&"x".repeat(200))).unwrap().chars().count(), MAX_NAME_CHARS);
    }

    /// The console decides which names are blank by the same rule, so a name
    /// one client shows as "Someone" is never shown blank by the other.
    #[test]
    fn names_clean_as_the_shared_vectors_say() {
        let names = fixture().names;
        assert_eq!(MAX_NAME_CHARS, names.max_chars, "both clients cut names at the same length");
        for case in &names.blank {
            assert_eq!(clean_name(Some(&case.name)), None, "blank: {}", case.label);
        }
        for case in &names.visible {
            let padded = format!(" {} ", case.name);
            assert_eq!(clean_name(Some(&padded)).as_deref(), Some(case.name.as_str()), "visible: {}", case.label);
        }
        for case in &names.cleaned {
            assert_eq!(
                clean_name(Some(&case.name)).as_deref(),
                Some(case.cleaned.as_str()),
                "cleaned: {}",
                case.label
            );
        }
    }

    /// The blank rule reaches both decrypted shapes, not only the helper.
    #[test]
    fn blank_names_decrypt_as_no_name() {
        let f = fixture();
        let key = CommentKey::derive(&share_key(&f));
        let nonce = [9u8; NONCE_LEN];
        let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        for case in &f.names.blank {
            let comment = serde_json::json!({ "text": "hi", "name": case.name }).to_string();
            let ct = seal_with_nonce(&key, &f.token, Purpose::Comment, &nonce, comment.as_bytes()).unwrap();
            let opened = open_comment(&key, &f.token, &b64(&nonce), &b64(&ct)).unwrap();
            assert_eq!(opened.name, None, "comment: {}", case.label);

            let viewer = serde_json::json!({ "name": case.name }).to_string();
            let ct = seal_with_nonce(&key, &f.token, Purpose::ViewerName, &nonce, viewer.as_bytes()).unwrap();
            assert_eq!(
                open_viewer_name(&key, &f.token, &b64(&nonce), &b64(&ct)).unwrap(),
                None,
                "viewer: {}",
                case.label
            );
        }
    }

    /// Characters that draw nothing on their own, drawn from each class the
    /// rule covers.
    const INVISIBLE_SAMPLE: &str = concat!(
        " \t\n\u{85}\u{A0}\u{3000}\u{1}\u{7F}\u{9B}\u{AD}\u{34F}\u{200B}\u{200C}",
        "\u{200D}\u{200E}\u{202E}\u{2060}\u{2066}\u{FE0F}\u{FEFF}\u{3164}\u{2800}\u{E0041}",
    );

    fn invisible_char() -> impl Strategy<Value = char> {
        proptest::sample::select(INVISIBLE_SAMPLE.chars().collect::<Vec<_>>())
    }

    /// Names that mix invisible characters with a few visible ones and run
    /// past the limit, so the cut, the blank check and the replacement of
    /// unsafe characters all get exercised.
    fn mixed_name() -> impl Strategy<Value = String> {
        let invisible = invisible_char();
        let visible = proptest::sample::select(vec!['a', 'Z', '\u{5C71}', '\u{1F600}', '\u{6DD}', '\u{2028}']);
        let pick = prop_oneof![8 => invisible, 1 => visible, 1 => any::<char>()];
        proptest::collection::vec(pick, 0..120).prop_map(|chars| chars.into_iter().collect())
    }

    proptest! {
        /// Whatever a viewer sends, a shown name has something visible in it,
        /// fits the limit, has no outer whitespace and nothing that reorders
        /// or garbles the row.
        #[test]
        fn a_shown_name_is_never_blank_or_unsafe(name in prop_oneof![any::<String>(), mixed_name()]) {
            if let Some(shown) = clean_name(Some(&name)) {
                prop_assert!(!is_blank_name(&shown));
                prop_assert!(shown.chars().count() <= MAX_NAME_CHARS);
                prop_assert_eq!(shown.trim_matches(is_js_whitespace), shown.as_str());
                prop_assert!(!shown.chars().any(is_display_unsafe));
            }
        }

        /// Any run of invisible characters is blank, however it is mixed.
        #[test]
        fn invisible_characters_alone_are_blank(picks in proptest::collection::vec(invisible_char(), 0..120)) {
            let name: String = picks.into_iter().collect();
            prop_assert!(is_blank_name(&name));
            prop_assert_eq!(clean_name(Some(&name)), None);
        }

        /// Joiners inside a name with visible text are kept as typed, so ZWJ
        /// emoji and ZWNJ in Persian or Indic names survive.
        #[test]
        fn joiners_inside_a_visible_name_are_kept(left in "[a-z]{1,20}", right in "[a-z]{1,20}", joiner in "[\u{200C}\u{200D}]") {
            let name = format!("{left}{joiner}{right}");
            prop_assert_eq!(clean_name(Some(&name)), Some(name));
        }
    }
}
