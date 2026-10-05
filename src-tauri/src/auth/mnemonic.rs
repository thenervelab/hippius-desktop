//! Fresh BIP-39 mnemonics for new accounts and local wallets.
//!
//! The entropy is read straight from the operating system's CSPRNG
//! (`rand::rngs::SysRng`, which is getrandom) and encoded with
//! `bip39::Mnemonic::from_entropy`. bip39's own `rand` feature stays off, so
//! which generator a wallet's key comes from is decided here, in one place,
//! rather than by whatever rand version bip39 happens to resolve.

use rand::TryRng;
use rand::rngs::SysRng;
use zeroize::Zeroizing;

use crate::error::AppError;

/// Bytes of entropy in a generated phrase: 128 bits, which BIP-39 encodes
/// as the 12 words every desktop flow mints.
const ENTROPY_BYTES: usize = 16;

// The `Mnemonic` built in `generate` holds the phrase's words; bip39 wipes
// them on drop only with its `zeroize` feature, which a version bump or a
// Cargo.toml edit could drop without any test noticing. Fail the build
// instead.
const _: fn() = || {
    fn wiped_on_drop<T: zeroize::ZeroizeOnDrop>() {}
    wiped_on_drop::<bip39::Mnemonic>();
};

/// Generates a new 12-word English BIP-39 phrase from OS entropy.
///
/// The entropy buffer, the intermediate `Mnemonic` and the returned phrase
/// are wiped on drop.
///
/// # Errors
///
/// [`AppError::Crypto`] when the OS random source fails; no phrase is
/// produced from partial entropy.
pub fn generate() -> Result<Zeroizing<String>, AppError> {
    let mut entropy = Zeroizing::new([0u8; ENTROPY_BYTES]);

    SysRng
        .try_fill_bytes(entropy.as_mut())
        .map_err(|e| AppError::Crypto(format!("the OS random number generator failed: {e}")))?;

    let mnemonic =
        bip39::Mnemonic::from_entropy(entropy.as_ref()).map_err(|e| AppError::Crypto(format!("BIP-39 encoding of fresh entropy failed: {e}")))?;
    Ok(phrase_of(&mnemonic))
}

/// The phrase, written into a buffer sized for it before the first word.
///
/// `to_string()` grows its buffer as it writes, and every reallocation
/// frees a partial copy of the phrase that nothing wipes. Sizing it up
/// front (the words, plus one space between each two) means the only copy
/// is the one `Zeroizing` wipes on drop.
fn phrase_of(mnemonic: &bip39::Mnemonic) -> Zeroizing<String> {
    let words = mnemonic.word_count();
    let len = mnemonic.words().map(str::len).sum::<usize>() + words.saturating_sub(1);
    let mut phrase = Zeroizing::new(String::with_capacity(len));
    for (i, word) in mnemonic.words().enumerate() {
        if i > 0 {
            phrase.push(' ');
        }
        phrase.push_str(word);
    }
    phrase
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(phrase: &str) -> bip39::Mnemonic {
        bip39::Mnemonic::parse_in_normalized(bip39::Language::English, phrase).expect("a generated phrase has a valid checksum")
    }

    #[test]
    fn twelve_words_encode_128_bits() {
        let phrase = generate().unwrap();
        let mnemonic = parse(&phrase);

        assert_eq!(mnemonic.word_count(), 12);
        assert_eq!(mnemonic.to_entropy().len(), 16);
    }

    /// The phrase is written into a buffer sized for it up front. Grown as
    /// it was built, each reallocation would leave a partial copy of the
    /// phrase in freed memory that nothing wipes.
    #[test]
    fn the_phrase_is_built_without_reallocating() {
        for _ in 0..16 {
            let phrase = generate().unwrap();
            assert_eq!(phrase.capacity(), phrase.len(), "{} words", phrase.split(' ').count());
        }
    }

    /// The hand-built phrase is exactly bip39's own rendering.
    #[test]
    fn the_phrase_matches_bip39s_rendering() {
        let mnemonic = bip39::Mnemonic::from_entropy(&[7u8; 16]).unwrap();
        assert_eq!(phrase_of(&mnemonic).as_str(), mnemonic.to_string());
    }

    /// Catches a generator that ignores its entropy (a zeroed buffer encodes
    /// "abandon ... about") or reuses it across calls.
    #[test]
    fn every_call_draws_fresh_entropy() {
        let phrases: std::collections::HashSet<String> = (0..16).map(|_| generate().unwrap().to_string()).collect();

        assert_eq!(phrases.len(), 16, "16 draws of 128 bits never collide");
        let zero = bip39::Mnemonic::from_entropy(&[0u8; 16]).unwrap().to_string();
        assert!(!phrases.contains(&zero), "the entropy buffer was filled");
    }
}
