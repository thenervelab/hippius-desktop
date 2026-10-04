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

/// How long a generated phrase is. BIP-39 maps 128 bits of entropy to 12
/// words and 256 bits to 24.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MnemonicLength {
    /// 12 words, 128 bits of entropy: what every desktop flow mints today.
    Twelve,
    /// 24 words, 256 bits of entropy.
    TwentyFour,
}

impl MnemonicLength {
    /// Bytes of entropy this length encodes.
    fn entropy_bytes(self) -> usize {
        match self {
            Self::Twelve => 16,
            Self::TwentyFour => 32,
        }
    }
}

/// Generates a new English BIP-39 phrase of `length` from OS entropy.
///
/// The entropy buffer and the returned phrase are wiped on drop.
///
/// # Errors
///
/// [`AppError::Crypto`] when the OS random source fails; no phrase is
/// produced from partial entropy.
pub fn generate(length: MnemonicLength) -> Result<Zeroizing<String>, AppError> {
    let mut entropy = Zeroizing::new([0u8; 32]);
    let entropy = &mut entropy[..length.entropy_bytes()];

    SysRng
        .try_fill_bytes(entropy)
        .map_err(|e| AppError::Crypto(format!("the OS random number generator failed: {e}")))?;

    let mnemonic = bip39::Mnemonic::from_entropy(entropy).map_err(|e| AppError::Crypto(format!("BIP-39 encoding of fresh entropy failed: {e}")))?;
    Ok(Zeroizing::new(mnemonic.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(phrase: &str) -> bip39::Mnemonic {
        bip39::Mnemonic::parse_in_normalized(bip39::Language::English, phrase).expect("a generated phrase has a valid checksum")
    }

    #[test]
    fn twelve_words_encode_128_bits() {
        let phrase = generate(MnemonicLength::Twelve).unwrap();
        let mnemonic = parse(&phrase);

        assert_eq!(mnemonic.word_count(), 12);
        assert_eq!(mnemonic.to_entropy().len(), 16);
    }

    #[test]
    fn twenty_four_words_encode_256_bits() {
        let phrase = generate(MnemonicLength::TwentyFour).unwrap();
        let mnemonic = parse(&phrase);

        assert_eq!(mnemonic.word_count(), 24);
        assert_eq!(mnemonic.to_entropy().len(), 32);
    }

    /// Catches a generator that ignores its entropy (a zeroed buffer encodes
    /// "abandon ... about") or reuses it across calls.
    #[test]
    fn every_call_draws_fresh_entropy() {
        let phrases: std::collections::HashSet<String> = (0..16).map(|_| generate(MnemonicLength::Twelve).unwrap().to_string()).collect();

        assert_eq!(phrases.len(), 16, "16 draws of 128 bits never collide");
        let zero = bip39::Mnemonic::from_entropy(&[0u8; 16]).unwrap().to_string();
        assert!(!phrases.contains(&zero), "the entropy buffer was filled");
    }
}
