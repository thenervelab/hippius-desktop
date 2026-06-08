//! Unit conversion and utility functions — planck ↔ human-readable, address validation, explorer URLs.

const DECIMALS: u32 = 18;

/// Maximum fractional digits to keep in the default display string.
///
/// Six digits lets us show amounts down to 1 µHIP (10^12 planck), matches
/// the precision wallet exchanges quote HIP at, and keeps every render
/// fitting on one line. Sites that need more precision (e.g. the
/// TokenForm "max" click-to-fill) can take the full-precision `*_hip`
/// string from the command return and truncate as needed.
const DEFAULT_DISPLAY_DECIMALS: usize = 6;

/// Convert a planck amount (as a decimal-digit string, e.g. `"1500000000000000000"`)
/// to a human-readable HIP string (e.g. `"1.5"`).
///
/// Uses string-level divmod so precision is preserved for values above
/// 2^53 — the pure-TS path (`Number(planck) / 10^18`) silently loses
/// precision beyond ~9 HIP, which is why this logic belongs on the Rust
/// side.
///
/// Returns `"0"` for zero, for empty input, and for any non-digit input.
/// Trailing zeros in the fractional part are stripped, so `"1500000000000000000"`
/// becomes `"1.5"` rather than `"1.500000000000000000"`. The fractional
/// part is truncated to [`DEFAULT_DISPLAY_DECIMALS`] digits — callers
/// that need more precision should pass the raw planck string to
/// [`planck_to_hip_full`].
pub fn planck_to_hip(planck: &str) -> String {
    planck_to_hip_with_decimals(planck, DEFAULT_DISPLAY_DECIMALS)
}

/// Same as [`planck_to_hip`] but keeps the full 18-digit fractional part
/// (trailing zeros still stripped). Used when the caller needs maximum
/// precision, e.g. for pre-filling a "send max" field where the UI
/// value round-trips back to planck for validation.
///
/// Exposed as a Tauri command so the frontend can ask for full
/// precision on demand (e.g. on a max-button click) without every
/// balance-returning command shipping two copies of each amount.
#[tauri::command]
pub fn planck_to_hip_full(planck: String) -> String {
    planck_to_hip_with_decimals(&planck, DECIMALS as usize)
}

/// Normalize an indexer-supplied numeric string to plain decimal digits.
///
/// The Hippius indexer returns some balance fields as scientific-notation
/// strings (`"1.23e+20"`) and some as plain integers (`"1230000000"`).
/// Planck amounts are always whole numbers of the smallest unit, so we
/// collapse any fractional/exponent form into a single decimal-digit
/// string. Non-parseable input falls through as `"0"` — the same
/// behavior the old `parse::<f64>().unwrap_or(0.0)` path gave.
pub fn normalize_decimal_digits(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "0".to_string();
    }
    // Fast path: already plain digits.
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        let stripped = trimmed.trim_start_matches('0');
        return if stripped.is_empty() { "0".to_string() } else { stripped.to_string() };
    }

    // Parse out optional sign, mantissa, optional exponent. Anything else
    // — embedded spaces, non-ASCII digits — falls through to "0".
    let (sign_is_negative, body) = match trimmed.as_bytes()[0] {
        b'-' => (true, &trimmed[1..]),
        b'+' => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };

    let (mantissa, exp) = match body.split_once(['e', 'E']) {
        Some((m, e)) => match e.parse::<i32>() {
            Ok(exp) => (m, exp),
            Err(_) => return "0".to_string(),
        },
        None => (body, 0),
    };

    let (int_part, frac_part) = match mantissa.split_once('.') {
        Some((i, f)) => (i, f),
        None => (mantissa, ""),
    };

    if !int_part.chars().all(|c| c.is_ascii_digit()) || !frac_part.chars().all(|c| c.is_ascii_digit()) {
        return "0".to_string();
    }

    // Shift the decimal point by `exp`, producing a string of digits with
    // no decimal point. Negative exponents that would push us below the
    // integer boundary truncate to zero (planck is an integer).
    let digits: String = int_part.chars().chain(frac_part.chars()).collect();
    let current_int_len = int_part.len() as i32;
    // saturating_add: a garbage exponent (e.g. "1e2000000000") must not overflow
    // i32. And cap the resulting integer length — a 40+-digit integer exceeds any
    // real balance (u128 is ~39 digits) and would otherwise make the zero-padding
    // below allocate a multi-gigabyte string (OOM). Garbage clamps to "0", like
    // the other malformed-input paths in this function.
    let target_int_len = current_int_len.saturating_add(exp);
    const MAX_PLANCK_DIGITS: i32 = 40;
    if target_int_len > MAX_PLANCK_DIGITS {
        return "0".to_string();
    }

    let mut result = if target_int_len >= digits.len() as i32 {
        let pad = target_int_len as usize - digits.len();
        format!("{digits}{}", "0".repeat(pad))
    } else if target_int_len > 0 {
        digits[..target_int_len as usize].to_string()
    } else {
        // Entire mantissa is below the integer boundary — planck is
        // zero (sub-unit precision is already discarded upstream).
        "0".to_string()
    };

    // Strip leading zeros, but keep at least one digit.
    let stripped = result.trim_start_matches('0');
    result = if stripped.is_empty() { "0".to_string() } else { stripped.to_string() };

    // Negative planck is nonsensical for our domain — clamp to zero.
    if sign_is_negative && result != "0" { "0".to_string() } else { result }
}

/// Pure string-divmod conversion of a planck string to a HIP-units string with
/// at most `max_fraction_digits` fraction digits, trailing zeros stripped.
///
/// Public to the crate so chart formatters can use the same precision-preserving
/// conversion as `planck_to_hip` instead of routing through `f64`, which silently
/// loses precision for any value above ~9 HIP at 6 decimals (2^53 / 10^18 ≈ 9).
pub(crate) fn planck_to_hip_with_decimals(planck: &str, max_fraction_digits: usize) -> String {
    let trimmed = planck.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        return "0".to_string();
    }
    // Strip leading zeros, but keep at least one digit.
    let normalized = trimmed.trim_start_matches('0');
    if normalized.is_empty() {
        return "0".to_string();
    }

    let dec = DECIMALS as usize;
    let (whole, fraction_full) = if normalized.len() <= dec {
        let zeros = dec - normalized.len();
        ("0".to_string(), format!("{:0<width$}{}", "", normalized, width = zeros))
    } else {
        let split = normalized.len() - dec;
        (normalized[..split].to_string(), normalized[split..].to_string())
    };

    // Truncate to `max_fraction_digits`, then strip trailing zeros.
    let fraction_capped: String = fraction_full.chars().take(max_fraction_digits).collect();
    let fraction_trimmed = fraction_capped.trim_end_matches('0');

    if fraction_trimmed.is_empty() {
        whole
    } else {
        format!("{whole}.{fraction_trimmed}")
    }
}

/// Convert a human-readable amount (e.g. "1.5") to planck string (18 decimals).
#[tauri::command]
pub fn to_plancks(amount: String) -> Result<String, crate::error::AppError> {
    if amount.is_empty() {
        return Err(crate::error::AppError::Validation("Invalid amount".into()));
    }
    // Bind the parsed value and enforce the planck domain (a non-negative
    // integer-of-base-units). Discarding the parse let "-1" through: the later
    // `trim_start_matches('0')` strips zeros but not the leading '-', so it
    // returned a malformed negative planck string. f64::parse also accepts
    // "NaN"/"inf", which are equally out of domain.
    let value = amount.parse::<f64>().map_err(|_| crate::error::AppError::Validation("Invalid amount".into()))?;
    if !value.is_finite() || value < 0.0 {
        return Err(crate::error::AppError::Validation("Amount must be a non-negative number".into()));
    }

    // The conversion below is pure string-shifting that assumes a plain
    // non-negative decimal ("123" or "123.45"). f64::parse is lenient — it
    // accepts "1e18", "+1", and (above) "inf"/"NaN" — and those slip past the
    // domain check only to be mangled by the digit concatenation below (e.g.
    // "1e18" became "1e18000000000000000000"). Reject anything that isn't ASCII
    // digits and at most one '.'.
    if amount.matches('.').count() > 1 || !amount.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err(crate::error::AppError::Validation("Amount must be a plain decimal number".into()));
    }

    let (whole, fraction) = match amount.split_once('.') {
        Some((w, f)) => (w, f),
        None => (amount.as_str(), ""),
    };

    let fraction_padded = if fraction.len() >= DECIMALS as usize {
        &fraction[..DECIMALS as usize]
    } else {
        &format!("{:0<width$}", fraction, width = DECIMALS as usize)
    };

    let combined = format!("{whole}{fraction_padded}");
    let trimmed = combined.trim_start_matches('0');
    if trimmed.is_empty() {
        Ok("0".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn to_plancks_integer() {
        assert_eq!(to_plancks("1".into()).unwrap(), "1000000000000000000");
    }

    #[test]
    fn to_plancks_decimal() {
        assert_eq!(to_plancks("1.5".into()).unwrap(), "1500000000000000000");
    }

    #[test]
    fn to_plancks_zero() {
        assert_eq!(to_plancks("0".into()).unwrap(), "0");
    }

    #[test]
    fn to_plancks_rejects_negative() {
        // planck is a non-negative integer; "-1" must error, not produce a
        // malformed "-1000…000" string (the leading '-' survived trim_start).
        assert!(to_plancks("-1".into()).is_err());
        assert!(to_plancks("-0.5".into()).is_err());
    }

    #[test]
    fn to_plancks_rejects_non_finite() {
        // f64::parse accepts "NaN"/"inf"; both are outside the domain.
        assert!(to_plancks("NaN".into()).is_err());
        assert!(to_plancks("inf".into()).is_err());
    }

    #[test]
    fn to_plancks_small_fraction() {
        assert_eq!(to_plancks("0.000000000000000001".into()).unwrap(), "1");
    }

    #[test]
    fn to_plancks_many_decimals_truncates() {
        assert_eq!(to_plancks("0.1234567890123456789999".into()).unwrap(), "123456789012345678");
    }

    #[test]
    fn to_plancks_invalid() {
        assert!(to_plancks("abc".into()).is_err());
        assert!(to_plancks(String::new()).is_err());
    }

    #[test]
    fn planck_to_hip_zero() {
        assert_eq!(planck_to_hip("0"), "0");
        assert_eq!(planck_to_hip("00000"), "0");
        assert_eq!(planck_to_hip(""), "0");
    }

    #[test]
    fn planck_to_hip_one_unit() {
        assert_eq!(planck_to_hip("1000000000000000000"), "1");
    }

    #[test]
    fn planck_to_hip_fractional() {
        assert_eq!(planck_to_hip("1500000000000000000"), "1.5");
        assert_eq!(planck_to_hip("1234500000000000000"), "1.2345");
    }

    #[test]
    fn planck_to_hip_sub_one_hip_referral_reward_is_not_zero() {
        // Referral rewards are frequently sub-1-HIP. `get_referral_links` used
        // integer division (`reward_raw / 10^18`), which truncated these to "0";
        // routing the planck value through this converter preserves the
        // fraction (audit 2026-06-05, finding C1).
        assert_eq!(planck_to_hip("500000000000000000"), "0.5");
        assert_eq!(planck_to_hip("12345000000000000"), "0.012345");
        assert_eq!(planck_to_hip("1"), "0"); // genuinely below the 6-decimal display floor
    }

    #[test]
    fn planck_to_hip_sub_unit() {
        // 0.000001 HIP — exactly at the 6-decimal display boundary.
        assert_eq!(planck_to_hip("1000000000000"), "0.000001");
        // 0.0000001 HIP — truncated away below the 6-decimal boundary.
        assert_eq!(planck_to_hip("100000000000"), "0");
    }

    #[test]
    fn planck_to_hip_beyond_f64_precision() {
        // 1e20 planck = 100 HIP. `Number(planck) / 10^18` in JS would
        // round-trip this as 100.00000000000001 or similar. The Rust
        // path preserves exact digits.
        assert_eq!(planck_to_hip("100000000000000000000"), "100");
        // A value with 20 significant digits — straightforward in our
        // string-based divmod, unrepresentable in f64.
        assert_eq!(planck_to_hip("123456789012345678901234"), "123456.789012");
    }

    #[test]
    fn planck_to_hip_full_keeps_precision() {
        assert_eq!(planck_to_hip_full("1".to_string()), "0.000000000000000001");
        assert_eq!(planck_to_hip_full("123456789012345678".to_string()), "0.123456789012345678");
    }

    #[test]
    fn planck_to_hip_invalid_input_is_zero() {
        // Non-digit input falls back to "0" rather than panicking — the
        // caller sees "0 HIP" instead of a crash from a malformed planck
        // string returned by a future API change.
        assert_eq!(planck_to_hip("not a number"), "0");
        assert_eq!(planck_to_hip("1.5"), "0");
        assert_eq!(planck_to_hip("-100"), "0");
    }

    #[test]
    fn normalize_plain_integer() {
        assert_eq!(normalize_decimal_digits("1230000000"), "1230000000");
        assert_eq!(normalize_decimal_digits("0"), "0");
        assert_eq!(normalize_decimal_digits("000000123"), "123");
    }

    #[test]
    fn normalize_scientific_notation() {
        assert_eq!(normalize_decimal_digits("1.23e+20"), "123000000000000000000");
        assert_eq!(normalize_decimal_digits("1E3"), "1000");
        assert_eq!(normalize_decimal_digits("5.5e2"), "550");
    }

    #[test]
    fn normalize_sub_unit_clamps_to_zero() {
        // Planck is an integer. Anything below 10^0 is the value 0 —
        // the indexer should never emit this, but we clamp instead of
        // erroring so a malformed upstream value becomes "0 HIP"
        // rather than a crash.
        assert_eq!(normalize_decimal_digits("1.5"), "1");
        assert_eq!(normalize_decimal_digits("0.5"), "0");
        assert_eq!(normalize_decimal_digits("5e-2"), "0");
    }

    #[test]
    fn normalize_garbage_is_zero() {
        assert_eq!(normalize_decimal_digits(""), "0");
        assert_eq!(normalize_decimal_digits("abc"), "0");
        assert_eq!(normalize_decimal_digits("1e"), "0");
        assert_eq!(normalize_decimal_digits("-5"), "0");
    }

    #[test]
    fn to_plancks_rejects_scientific_notation_fixture() {
        // f64 accepts "1e18"; the string path used to emit "1e18000…000".
        assert!(to_plancks("1e18".into()).is_err());
        assert!(to_plancks("1E18".into()).is_err());
        assert!(to_plancks("+1".into()).is_err());
    }

    #[test]
    fn normalize_huge_exponent_clamps_not_panics() {
        // i32::MAX exponent: `current_int_len + exp` would overflow i32 without
        // saturating_add; an exponent past the planck-digit cap clamps to "0"
        // instead of panicking (debug) or OOM-allocating a giant zero pad (release).
        assert_eq!(normalize_decimal_digits("5e2147483647"), "0");
        assert_eq!(normalize_decimal_digits("9e100"), "0");
    }

    proptest! {
        // to_plancks must never emit a mangled value: whatever it accepts, the
        // output is a pure digit string — no leftover 'e'/'+'/'-'/'.', never
        // "1e18000…" or "+1000…". This is the invariant the sci-notation bug broke.
        #[test]
        fn to_plancks_output_is_pure_digits(s in ".*") {
            if let Ok(planck) = to_plancks(s.clone()) {
                prop_assert!(planck.bytes().all(|b| b.is_ascii_digit()), "to_plancks({s:?}) = {planck:?}");
            }
        }

        // An integer N converts to exactly N * 10^18 planck (round-trip through the
        // digit string). u64::MAX * 10^18 < u128::MAX, so the product is exact.
        #[test]
        fn to_plancks_integer_is_n_times_1e18(n in 0u64..=u64::MAX) {
            let planck = to_plancks(n.to_string()).expect("integer converts");
            let got: u128 = planck.parse().expect("pure digits");
            prop_assert_eq!(got, u128::from(n) * 1_000_000_000_000_000_000u128); // 10^DECIMALS (18)
        }

        // Scientific notation is rejected for any base/exponent.
        #[test]
        fn to_plancks_rejects_sci(base in 0u64..1_000_000u64, exp in 1u32..30) {
            let lower = format!("{base}e{exp}");
            let upper = format!("{base}E{exp}");
            prop_assert!(to_plancks(lower).is_err());
            prop_assert!(to_plancks(upper).is_err());
        }

        // normalize_decimal_digits never panics/OOMs even at the i32 exponent
        // boundary, and always returns a pure digit string.
        #[test]
        fn normalize_handles_huge_exponents(base in 1u32..1000, exp in 0i64..=2_147_483_647i64) {
            let out = normalize_decimal_digits(&format!("{base}e{exp}"));
            prop_assert!(out.bytes().all(|b| b.is_ascii_digit()));
        }

        // For arbitrary number-ish strings the output is always pure digits.
        #[test]
        fn normalize_output_is_always_digits(s in r"[-+]?[0-9]{0,18}\.?[0-9]{0,18}([eE][-+]?[0-9]{0,9})?") {
            let out = normalize_decimal_digits(&s);
            prop_assert!(out.bytes().all(|b| b.is_ascii_digit()));
        }
    }
}
