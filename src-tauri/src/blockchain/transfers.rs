//! Balance transfer commands — send funds, validate transfers.

use crate::blockchain::client::get_substrate_client;
use crate::blockchain::convert::to_plancks;
use crate::blockchain::helpers::{get_signer, get_substrate_address, sign_submit_track};
use crate::blockchain::queries::validate_address;
use crate::blockchain::runtime::custom_runtime;
use crate::blockchain::types::{TxOutcome, ValidatedTransfer};
use std::str::FromStr;
use tracing::info;

/// Estimated transaction fee in planck — used by `validate_send_balance`
/// for the "can the user afford this transfer at all" check.
const ESTIMATED_TRANSFER_FEE_PLANCK: u128 = 270_233_151;

/// Headroom subtracted from the MAX button so the resulting transfer
/// always leaves enough free balance for follow-up extrinsics (e.g. an
/// unstake or a credit top-up) without forcing the user to top up gas.
///
/// 0.01 hAlpha (= 10^16 planck) is much larger than any single Polkadot
/// extrinsic fee on this chain (~10^-10 hAlpha) but small enough that the
/// user doesn't notice it being held back. Mirrors hippius-web's
/// `GAS_FEE_BUFFER_PLANCKS = PLANCKS_PER_TOKEN / 100` so the two clients
/// behave identically when the user presses MAX.
const MAX_GAS_FEE_BUFFER_PLANCK: u128 = 10_000_000_000_000_000;

/// Max-transferable amount for the "Send Max" UX on the balance page.
///
/// Pure function — takes a planck balance string, subtracts the gas
/// buffer, and returns both the remaining planck and the formatted HIP
/// string. Lives in Rust so the buffer constant, the BigInt subtraction,
/// and the planck→HIP conversion are all owned by the backend (the same
/// places the actual transfer logic lives).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaxTransferable {
    pub planck: String,
    pub hip: String,
}

#[tauri::command]
pub fn compute_max_transferable(balance_planck: String) -> MaxTransferable {
    let balance = balance_planck.parse::<u128>().unwrap_or(0);
    let max_planck = balance.saturating_sub(MAX_GAS_FEE_BUFFER_PLANCK);
    let planck = max_planck.to_string();
    let hip = crate::blockchain::convert::planck_to_hip_full(planck.clone());
    MaxTransferable { planck, hip }
}

/// Transfer balance using the active local wallet's keypair.
/// Requires the wallet's password — decrypted in Rust, never cached.
#[tauri::command]
pub async fn transfer_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    recipient_address: String,
    amount: String,
    password: String,
) -> Result<TxOutcome, crate::error::AppError> {
    // Validate inputs BEFORE deriving the signing key, so a direct IPC call
    // can't reach the signer (or sign anything) with a zero amount or a
    // malformed recipient. The command previously trusted that the FE's
    // `validate_send_balance` ran first (audit R-29).
    let (amount, recipient) = validate_transfer_inputs(&amount, &recipient_address)?;

    let signer = get_signer(&state, &password).await?;
    let client = get_substrate_client(&state).await?;

    info!("Submitting transfer_keep_alive transaction...");
    let tx = custom_runtime::tx().balances().transfer_keep_alive(recipient.into(), amount);

    let outcome = sign_submit_track(&client, &tx, &signer).await?;
    info!("Transfer outcome: {outcome:?}");
    Ok(outcome)
}

/// Parse and validate a transfer's amount + recipient — the IPC's self-guard
/// (audit R-29). Pure so it's unit-testable without a wallet/chain.
///
/// Rejects a non-numeric or zero `amount` and a malformed recipient SS58. The
/// `AccountId32` parse validates the SS58 checksum (network-prefix matching is
/// the separate R-27 hardening). Recipient parses directly as a
/// `subxt::utils::AccountId32` — avoids the removed `sp_core` → `MultiAddress`
/// conversion that only existed under `substrate-compat`.
fn validate_transfer_inputs(amount: &str, recipient_address: &str) -> Result<(u128, subxt::utils::AccountId32), crate::error::AppError> {
    let amount: u128 = amount
        .parse()
        .map_err(|e| crate::error::AppError::Validation(format!("Invalid amount: {e}")))?;
    if amount == 0 {
        return Err(crate::error::AppError::Validation("Amount must be greater than zero".into()));
    }
    let recipient = subxt::utils::AccountId32::from_str(recipient_address)
        .map_err(|e| crate::error::AppError::Validation(format!("Invalid recipient address: {e:?}")))?;
    Ok((amount, recipient))
}

/// The raw SS58 network-prefix bytes of an address (1 or 2 bytes per the SS58
/// spec), or `None` if it doesn't base58-decode to a valid prefix.
///
/// We compare prefix *bytes* rather than decoding the prefix integer, so two
/// addresses on the same network compare equal with no need to know the
/// network's numeric id.
fn ss58_prefix_bytes(address: &str) -> Option<Vec<u8>> {
    let data = bs58::decode(address).into_vec().ok()?;
    let prefix_len = match *data.first()? {
        0..=63 => 1,
        64..=127 => 2,
        _ => return None,
    };
    (data.len() >= prefix_len).then(|| data[..prefix_len].to_vec())
}

/// True if two SS58 addresses share the same network prefix. Fails **open**
/// (returns `true`) if either address can't be decoded — the checksum is
/// validated separately, and this guard must never reject a legitimate
/// same-network transfer on a decode quirk.
fn same_ss58_network(a: &str, b: &str) -> bool {
    match (ss58_prefix_bytes(a), ss58_prefix_bytes(b)) {
        (Some(pa), Some(pb)) => pa == pb,
        _ => true,
    }
}

/// Validate a balance transfer in a single call — fetches balance from chain.
#[tauri::command]
pub async fn validate_send_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    recipient_address: String,
    amount: String,
) -> Result<ValidatedTransfer, crate::error::AppError> {
    if !validate_address(recipient_address.clone()) {
        return Err(crate::error::AppError::Validation("Invalid recipient address".into()));
    }

    let address = get_substrate_address(&state).await?;

    // Reject a recipient on a different SS58 network than the sender's own
    // wallet (e.g. a Polkadot/Kusama address pasted into a Hippius wallet): it
    // decodes to the same 32-byte key but a *different* account, so funds would
    // leave the Hippius network (audit R-27). The sender's address defines the
    // expected prefix, so no Hippius prefix is hardcoded.
    if !same_ss58_network(&address, &recipient_address) {
        return Err(crate::error::AppError::Validation(
            "Recipient is on a different network. Enter a Hippius address.".into(),
        ));
    }

    let client = get_substrate_client(&state).await?;
    let account_id: subxt::utils::AccountId32 = address
        .parse()
        .map_err(|_| crate::error::AppError::Validation(format!("Invalid sender address: {address}")))?;
    let storage_query = custom_runtime::storage().system().account(&account_id);
    let account_info = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Storage error: {e}")))?
        .fetch(&storage_query)
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Query failed: {e}")))?;
    // Transferable balance excludes the frozen portion (locks/holds from
    // staking, vesting, etc.). `free` alone over-counts what the user can
    // actually send, so a transfer that looks affordable could be rejected
    // on-chain. `saturating_sub` because frozen can momentarily exceed free
    // during reconfiguration.
    let available: u128 = account_info.map_or(0, |i| i.data.free.saturating_sub(i.data.frozen));

    let planck_str = to_plancks(amount)?;
    let planck: u128 = planck_str
        .parse()
        .map_err(|_| crate::error::AppError::Validation("Invalid planck amount".into()))?;

    if planck == 0 {
        return Err(crate::error::AppError::Validation("Amount must be greater than zero".into()));
    }

    if planck > available {
        return Err(crate::error::AppError::Validation("Amount exceeds your available balance".into()));
    }
    if planck.saturating_add(ESTIMATED_TRANSFER_FEE_PLANCK) > available {
        return Err(crate::error::AppError::Validation(
            "Amount (incl. transaction fee) exceeds your balance".into(),
        ));
    }

    let estimated_fee = ESTIMATED_TRANSFER_FEE_PLANCK.to_string();
    let available_balance_planck = available.to_string();
    Ok(ValidatedTransfer {
        planck_amount_hip: crate::blockchain::convert::planck_to_hip(&planck_str),
        estimated_fee_hip: crate::blockchain::convert::planck_to_hip(&estimated_fee),
        available_balance_hip: crate::blockchain::convert::planck_to_hip(&available_balance_planck),
        planck_amount: planck_str,
        estimated_fee,
        available_balance_planck,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_SS58: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

    #[test]
    fn validate_transfer_inputs_accepts_valid() {
        let (amount, _recipient) = validate_transfer_inputs("1000000000000000000", VALID_SS58).expect("valid inputs");
        assert_eq!(amount, 1_000_000_000_000_000_000);
    }

    // The three canonical Alice addresses — same 32-byte key, different SS58
    // network prefixes (generic-substrate 42 / Polkadot 0 / Kusama 2).
    const ALICE_SUBSTRATE: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const ALICE_POLKADOT: &str = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
    const ALICE_KUSAMA: &str = "HNZata7iMYWmk5RvZRTiAsSDhV8366zq2YGb3tLH5Upf74F";

    #[test]
    fn same_ss58_network_matches_same_prefix() {
        assert!(same_ss58_network(ALICE_SUBSTRATE, ALICE_SUBSTRATE));
    }

    #[test]
    fn same_ss58_network_rejects_cross_network_addresses() {
        // R-27: a Polkadot- or Kusama-prefixed address pasted into a
        // (substrate-prefixed) Hippius wallet must be flagged as a different
        // network, even though all three decode to the same underlying key.
        assert!(!same_ss58_network(ALICE_SUBSTRATE, ALICE_POLKADOT));
        assert!(!same_ss58_network(ALICE_SUBSTRATE, ALICE_KUSAMA));
        assert!(!same_ss58_network(ALICE_POLKADOT, ALICE_KUSAMA));
    }

    #[test]
    fn same_ss58_network_fails_open_on_undecodable() {
        // Never reject a transfer on a decode quirk — the checksum is validated
        // elsewhere. Undecodable input compares as "same network".
        assert!(same_ss58_network(ALICE_SUBSTRATE, "not-an-address"));
    }

    #[test]
    fn validate_transfer_inputs_rejects_zero_amount() {
        // R-29: a zero-amount transfer must be refused before any signing.
        assert!(validate_transfer_inputs("0", VALID_SS58).is_err());
    }

    #[test]
    fn validate_transfer_inputs_rejects_non_numeric_amount() {
        assert!(validate_transfer_inputs("", VALID_SS58).is_err());
        assert!(validate_transfer_inputs("abc", VALID_SS58).is_err());
        assert!(validate_transfer_inputs("-5", VALID_SS58).is_err());
    }

    #[test]
    fn validate_transfer_inputs_rejects_bad_recipient() {
        assert!(validate_transfer_inputs("1000", "not-an-address").is_err());
        assert!(validate_transfer_inputs("1000", "").is_err());
    }
}
