//! Unit conversion and utility functions — planck ↔ human-readable, address validation, explorer URLs.

const DECIMALS: u32 = 18;
const EXPLORER_BASE: &str = "https://hipstats.com";

/// Convert a human-readable amount (e.g. "1.5") to planck string (18 decimals).
#[tauri::command]
pub fn to_plancks(amount: String) -> Result<String, crate::error::AppError> {
    if amount.is_empty() {
        return Err(crate::error::AppError::Other("Invalid amount".into()));
    }
    amount.parse::<f64>().map_err(|_| "Invalid amount".to_string())?;

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

/// Convert a planck string to human-readable f64 (divide by 10^18).
#[tauri::command]
pub fn from_plancks(plancks: String) -> Result<f64, crate::error::AppError> {
    let value: f64 = plancks.parse().map_err(|_| "Invalid planck value".to_string())?;
    Ok(value / 1e18)
}

/// Return the explorer URL for an address.
#[tauri::command]
pub fn get_explorer_url(address: String) -> String {
    format!("{EXPLORER_BASE}/accounts/{address}")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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
    fn from_plancks_basic() {
        let result = from_plancks("1000000000000000000".into()).unwrap();
        assert!((result - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn from_plancks_zero() {
        let result = from_plancks("0".into()).unwrap();
        assert!((result - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn from_plancks_invalid() {
        assert!(from_plancks("not_a_number".into()).is_err());
    }

    #[test]
    fn explorer_url() {
        let url = get_explorer_url("5GrwvaEF".into());
        assert_eq!(url, "https://hipstats.com/accounts/5GrwvaEF");
    }
}
