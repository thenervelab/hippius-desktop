//! Balance, staking, and on-chain data queries.

use crate::blockchain::client::get_substrate_client;
use crate::blockchain::convert::planck_to_hip;
use crate::blockchain::helpers::get_substrate_address;
use crate::blockchain::runtime::custom_runtime;
use crate::blockchain::types::{AccountBalance, BlockTimestampResult, ReferralLink, StakingInfo, UnbondingPeriod};

/// Query `system.account(address)` for free/reserved/frozen balance.
#[tauri::command]
pub async fn get_account_balance(
    state: tauri::State<'_, crate::app_state::AppState>,
    address: String,
) -> Result<AccountBalance, crate::error::AppError> {
    let client = get_substrate_client(&state).await.map_err(crate::error::AppError::Substrate)?;
    let account_id: subxt::utils::AccountId32 = address.parse().map_err(|_| crate::error::AppError::Validation(format!("Invalid SS58 address: {address}")))?;
    let storage_query = custom_runtime::storage().system().account(&account_id);
    let account_info = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Storage error: {e}")))?
        .fetch(&storage_query)
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Query failed: {e}")))?;

    let (free, reserved, frozen) = match account_info {
        Some(info) => (info.data.free.to_string(), info.data.reserved.to_string(), info.data.frozen.to_string()),
        None => ("0".to_string(), "0".to_string(), "0".to_string()),
    };
    Ok(AccountBalance {
        free_hip: planck_to_hip(&free),
        reserved_hip: planck_to_hip(&reserved),
        frozen_hip: planck_to_hip(&frozen),
        free,
        reserved,
        frozen,
    })
}

/// Transferable balance = `free` minus every still-frozen portion.
///
/// On pallet_staking, the account's `free` balance includes the active bonded
/// stake AND every unlocking chunk — both chunks still inside the unbonding
/// period (`unbonding_total`) and chunks whose era has matured but have not yet
/// been released by an explicit `withdraw_unbonded` extrinsic
/// (`withdrawable_total`). All three remain locked and unspendable until
/// withdrawal, so all three are subtracted. Earlier code omitted
/// `withdrawable_total`, over-reporting spendable balance for users who
/// unbonded, waited out the period, but had not yet withdrawn — the chain then
/// rejects a transfer of the over-reported amount. Saturating so a transiently
/// inconsistent storage snapshot (locked sum momentarily exceeding free) yields
/// 0 rather than underflowing.
fn spendable_balance(free: u128, bonded: u128, unbonding_total: u128, withdrawable_total: u128) -> u128 {
    free.saturating_sub(bonded).saturating_sub(unbonding_total).saturating_sub(withdrawable_total)
}

/// Query staking state for the current authenticated user.
/// Fetch staking state.
///
/// `account_id` is optional: callers that want the active local wallet's
/// stake (the wallet-page cards & dialogs) pass `None` and we fall back
/// to `get_substrate_address` which already reads the active wallet.
/// Callers that want the auth/login account's stake (the global page
/// header, which shouldn't jump every time the user switches local
/// wallets in `/wallet`) pass the auth SS58 explicitly. Same data
/// shape returned either way.
#[tauri::command]
pub async fn get_staking_info(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: Option<String>,
) -> Result<StakingInfo, crate::error::AppError> {
    let address = match account_id {
        Some(a) => a,
        None => get_substrate_address(&state).await?,
    };
    let client = get_substrate_client(&state).await.map_err(crate::error::AppError::Substrate)?;
    let account_id: subxt::utils::AccountId32 = address.parse().map_err(|_| crate::error::AppError::Validation(format!("Invalid SS58 address: {address}")))?;

    // Single RPC call — all queries use the same block snapshot
    let storage = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Storage error: {e}")))?;

    let balance_query = custom_runtime::storage().system().account(&account_id);
    let balance_info = storage
        .fetch(&balance_query)
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Balance query failed: {e}")))?;
    let free_balance = balance_info.map_or_else(|| "0".to_string(), |info| info.data.free.to_string());

    let mut bonded = "0".to_string();
    let mut unbonding_total: u128 = 0;
    let mut withdrawable_total: u128 = 0;
    let mut unbonding_periods = Vec::new();

    let current_era_query = custom_runtime::storage().staking().current_era();
    let current_era: u32 = storage
        .fetch(&current_era_query)
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Era query failed: {e}")))?
        .unwrap_or(0);

    // Block-precise countdown data for unbonding chunks. Mirrors the
    // values hippius-web reads from `derive.session.progress`:
    //   era_length    = sessions_per_era × epoch_duration   (blocks)
    //   era_progress  = sessions_into_era × epoch_duration  + slot_in_epoch
    //   remaining_blocks(chunk) = (remaining_eras - 1) × era_length
    //                           + (era_length - era_progress)
    //
    // Every query is wrapped in `.ok().flatten()` so a single missing
    // entry (older runtime, RPC error) leaves the chunk's
    // `remaining_blocks = None` and the frontend falls back to era
    // count — the staking info request as a whole still succeeds.
    // `client.constants().at(&addr)` reads a runtime constant; both
    // queries return `Result` so we collapse to `Option<u64>` and skip
    // the rest of the era-progress math if either is missing.
    let epoch_duration_blocks: Option<u64> = client
        .constants()
        .at(&custom_runtime::constants().babe().epoch_duration())
        .ok();
    let sessions_per_era: Option<u32> = client
        .constants()
        .at(&custom_runtime::constants().staking().sessions_per_era())
        .ok();
    let era_length: Option<u64> = match (epoch_duration_blocks, sessions_per_era) {
        (Some(ed), Some(spe)) => Some(ed.saturating_mul(spe as u64)),
        _ => None,
    };

    let era_progress: Option<u64> = match (era_length, epoch_duration_blocks) {
        (Some(era_len), Some(epoch_duration)) if era_len > 0 && epoch_duration > 0 => {
            let era_start_session_query = custom_runtime::storage()
                .staking()
                .eras_start_session_index(current_era);
            let era_start_session = storage.fetch(&era_start_session_query).await.ok().flatten();

            let current_session_query = custom_runtime::storage().session().current_index();
            let current_session = storage.fetch(&current_session_query).await.ok().flatten();

            let current_slot_query = custom_runtime::storage().babe().current_slot();
            let current_slot = storage.fetch(&current_slot_query).await.ok().flatten();
            let genesis_slot_query = custom_runtime::storage().babe().genesis_slot();
            let genesis_slot = storage.fetch(&genesis_slot_query).await.ok().flatten();

            match (era_start_session, current_session, current_slot, genesis_slot) {
                (Some(ess), Some(cs), Some(slot), Some(gen_slot)) => {
                    let sessions_into_era = (cs as u64).saturating_sub(ess as u64);
                    let slot_in_epoch =
                        (slot.0.saturating_sub(gen_slot.0)) % epoch_duration;
                    let progress = sessions_into_era
                        .saturating_mul(epoch_duration)
                        .saturating_add(slot_in_epoch);
                    Some(progress.min(era_len))
                }
                _ => None,
            }
        }
        _ => None,
    };

    let compute_remaining_blocks = |remaining_eras: u32| -> Option<u64> {
        let era_len = era_length?;
        let progress = era_progress?;
        if remaining_eras == 0 {
            return Some(0);
        }
        let preceding = (remaining_eras as u64).saturating_sub(1).saturating_mul(era_len);
        let current = era_len.saturating_sub(progress);
        Some(preceding.saturating_add(current))
    };

    let ledger_query = custom_runtime::storage().staking().ledger(&account_id);
    // Propagate a ledger RPC failure instead of collapsing it into "no stake":
    // the previous `if let Ok(Some(_))` treated a network/codec error like a
    // genuinely unbonded account and returned zeroed StakingInfo as success, so
    // the FE showed 0 bonded for a real staker. `None` (no ledger = not staking)
    // still legitimately keeps the zeros; only `Err` now surfaces. Mirrors the
    // `?` handling of the balance and current_era fetches above.
    let ledger = storage
        .fetch(&ledger_query)
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Ledger query failed: {e}")))?;
    if let Some(ledger) = ledger {
        bonded = ledger.active.to_string();
        for chunk in &ledger.unlocking.0 {
            let unlock_era = chunk.era;
            let amount = chunk.value;
            let remaining = unlock_era.saturating_sub(current_era);
            if remaining == 0 {
                // Defensive arithmetic mirroring `available`'s `saturating_sub`
                // below: these accumulate on-chain ledger values, so clamp at
                // u128::MAX instead of wrapping silently in release builds.
                withdrawable_total = withdrawable_total.saturating_add(amount);
            } else {
                unbonding_total = unbonding_total.saturating_add(amount);
                let amount_str = amount.to_string();
                unbonding_periods.push(UnbondingPeriod {
                    amount_hip: planck_to_hip(&amount_str),
                    amount: amount_str,
                    era: unlock_era,
                    remaining_eras: remaining,
                    remaining_blocks: compute_remaining_blocks(remaining),
                });
            }
        }
    }

    let rewards = "0".to_string();
    let total: u128 = free_balance.parse().unwrap_or(0);
    let bonded_u128: u128 = bonded.parse().unwrap_or(0);
    let available = spendable_balance(total, bonded_u128, unbonding_total, withdrawable_total);

    let unbonding = unbonding_total.to_string();
    let withdrawable = withdrawable_total.to_string();
    let available_balance = available.to_string();

    Ok(StakingInfo {
        bonded_hip: planck_to_hip(&bonded),
        rewards_hip: planck_to_hip(&rewards),
        unbonding_hip: planck_to_hip(&unbonding),
        withdrawable_hip: planck_to_hip(&withdrawable),
        balance_hip: planck_to_hip(&free_balance),
        available_balance_hip: planck_to_hip(&available_balance),
        bonded,
        rewards,
        unbonding,
        withdrawable,
        balance: free_balance,
        available_balance,
        unbonding_periods,
    })
}

/// Query the on-chain timestamp for a given block number.
#[tauri::command]
pub async fn get_block_timestamp(
    state: tauri::State<'_, crate::app_state::AppState>,
    block_number: u64,
) -> Result<BlockTimestampResult, crate::error::AppError> {
    use subxt::backend::legacy::LegacyRpcMethods;

    let client = get_substrate_client(&state).await.map_err(crate::error::AppError::Substrate)?;

    // Get the RPC handle through the connect-aware helper so it can't spuriously
    // report "RPC client not initialized" when the rpc_client cache was cleared
    // concurrently while the OnlineClient above stayed cached — both are
    // re-derived together. See client::get_rpc_client.
    let rpc = crate::blockchain::client::get_rpc_client(&state).await.map_err(crate::error::AppError::Substrate)?;
    let legacy: LegacyRpcMethods<subxt::PolkadotConfig> = LegacyRpcMethods::new(rpc);

    let block_hash = legacy
        .chain_get_block_hash(Some(block_number.into()))
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Block hash query failed: {e}")))?
        .ok_or_else(|| format!("Block {block_number} not found"))?;

    let timestamp_query = custom_runtime::storage().timestamp().now();
    let timestamp: u64 = client
        .storage()
        .at(block_hash)
        .fetch(&timestamp_query)
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Timestamp query failed: {e}")))?
        // A missing timestamp storage entry is surfaced as an error rather than
        // collapsed to epoch 0, so the FE can tell "unavailable" from a genuine
        // 1970 value (the block-hash step above already errors on not-found).
        .ok_or_else(|| crate::error::AppError::Substrate(format!("No timestamp for block {block_number}")))?;

    Ok(BlockTimestampResult { timestamp })
}

/// Substrate storage key layout for a `Blake2_128Concat`-hashed map
/// with a bytes-typed key is
///   `[twox_128(pallet)(16) | twox_128(storage)(16) | blake2_128(key)(16) | raw_key(N)]`.
/// The first 48 bytes are deterministic prefix; the remainder is the
/// raw key — i.e. the actual referral code string.
const REFERRAL_KEY_PREFIX_LEN: usize = 48;

/// Extract the raw referral code bytes from a Substrate storage map
/// entry key. Returns `None` when the key is shorter than the
/// 48-byte prefix (shouldn't happen with a real on-chain entry; the
/// guard exists so we can't accidentally panic-slice on malformed
/// data). The earlier implementation grabbed the LAST 32 bytes of the
/// storage key, which only matched the raw key when the code happened
/// to be exactly 32 bytes long. For shorter codes (`HIPPIUS<N-digit-id>`
/// is typically 26–27 bytes), that slice bled the trailing bytes of
/// the Blake2_128 hash into the front of the result, which then
/// surfaced in the UI as `�` Unicode replacement characters after a
/// lossy UTF-8 decode.
fn extract_referral_code_bytes(key_bytes: &[u8]) -> Option<&[u8]> {
    if key_bytes.len() <= REFERRAL_KEY_PREFIX_LEN {
        return None;
    }
    Some(&key_bytes[REFERRAL_KEY_PREFIX_LEN..])
}

/// Fetch referral links (codes + rewards) for the given address.
#[tauri::command]
pub async fn get_referral_links(
    state: tauri::State<'_, crate::app_state::AppState>,
    address: String,
) -> Result<Vec<ReferralLink>, crate::error::AppError> {
    let client = get_substrate_client(&state).await.map_err(crate::error::AppError::Substrate)?;
    let target_account: subxt::utils::AccountId32 = address.parse().map_err(|_| "Invalid address".to_string())?;

    let storage = client
        .storage()
        .at_latest()
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("Storage error: {e}")))?;

    let query = custom_runtime::storage().credits().referral_codes_iter();
    let mut entries = storage
        .iter(query)
        .await
        .map_err(|e| crate::error::AppError::Substrate(format!("ReferralCodes query failed: {e}")))?;

    let decimals = 10u128.pow(18);

    // Walk the iterator sequentially (subxt requires &mut self for next).
    // Collect matching codes first, then fan out the per-code reward
    // fetches concurrently with `try_join_all`. Previously each match's
    // reward fetch was awaited inline before pulling the next entry, so
    // a user with K matches paid K serial RPC round-trips on top of the
    // O(N) iteration. Now the K reward fetches run in parallel against
    // the same `at_latest()` snapshot.
    //
    // For each match we recover the raw code bytes from the storage
    // key (see `extract_referral_code_bytes`) and accept the entry
    // only if those bytes decode as valid UTF-8 — referral codes are
    // ASCII strings of the form `HIPPIUS<digits>`, so anything else is
    // a malformed on-chain row we'd rather skip than render with `�`
    // replacement chars.
    let mut matched_codes: Vec<(Vec<u8>, String)> = Vec::new();
    // Propagate a mid-iteration RPC error rather than ending the loop silently:
    // `while let Some(Ok(entry))` stopped on the first `Some(Err(_))` and
    // returned the codes matched so far as `Ok`, so a dropped subscription
    // produced a partial referral list that looked complete to the FE. The
    // body keeps redesign's strict decode path (`extract_referral_code_bytes`
    // + UTF-8 validation) rather than the audit branch's raw key slicing.
    while let Some(result) = entries.next().await {
        let entry = result
            .map_err(|e| crate::error::AppError::Substrate(format!("ReferralCodes iteration failed: {e}")))?;
        if entry.value != target_account {
            continue;
        }
        let Some(code_slice) = extract_referral_code_bytes(&entry.key_bytes) else {
            continue;
        };
        let Ok(code) = std::str::from_utf8(code_slice) else {
            continue;
        };
        matched_codes.push((code_slice.to_vec(), code.to_string()));
    }

    let storage_ref = &storage;
    let reward_futures = matched_codes.iter().map(|(code_bytes, _)| {
        let reward_query = custom_runtime::storage().credits().referral_code_rewards(code_bytes.as_slice());
        async move {
            storage_ref
                .fetch(&reward_query)
                .await
                .map(|opt| opt.unwrap_or(0u128))
                .map_err(|e| crate::error::AppError::Substrate(format!("Reward query failed: {e}")))
        }
    });
    let rewards: Vec<u128> = futures_util::future::try_join_all(reward_futures).await?;

    let links = matched_codes
        .into_iter()
        .zip(rewards)
        .map(|((_, code), reward_raw)| ReferralLink {
            code,
            reward: (reward_raw / decimals).to_string(),
        })
        .collect();

    Ok(links)
}

/// Validate whether a string is a valid SS58 (Substrate) address.
#[tauri::command]
pub fn validate_address(address: String) -> bool {
    address.parse::<subxt::utils::AccountId32>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::{extract_referral_code_bytes, spendable_balance, REFERRAL_KEY_PREFIX_LEN};
    use proptest::prelude::*;

    #[test]
    fn spendable_excludes_matured_but_unwithdrawn_chunks() {
        // free = 100 = 40 active bonded + 30 still-unbonding + 20 matured-but-
        // -unwithdrawn + 10 genuinely free. Only the 10 is spendable; the 20
        // matured chunk stays locked until withdraw_unbonded (the regression).
        assert_eq!(spendable_balance(100, 40, 30, 20), 10);
    }

    #[test]
    fn spendable_is_zero_when_everything_is_locked() {
        assert_eq!(spendable_balance(100, 100, 0, 0), 0);
        assert_eq!(spendable_balance(100, 0, 60, 40), 0);
    }

    #[test]
    fn spendable_saturates_instead_of_underflowing() {
        // Inconsistent snapshot: locked sum exceeds free. Must clamp at 0.
        assert_eq!(spendable_balance(10, 50, 50, 50), 0);
    }

    proptest! {
        // Spendable can never exceed free, and locking more (raising any frozen
        // component) can never increase it — the core monotonicity invariants.
        #[test]
        fn spendable_never_exceeds_free(free in any::<u128>(), bonded in any::<u128>(), unbonding in any::<u128>(), withdrawable in any::<u128>()) {
            let s = spendable_balance(free, bonded, unbonding, withdrawable);
            prop_assert!(s <= free);
        }

        #[test]
        fn spendable_monotonic_in_withdrawable(free in any::<u128>(), bonded in any::<u128>(), unbonding in any::<u128>(), w1 in any::<u128>(), extra in any::<u128>()) {
            let w2 = w1.saturating_add(extra);
            prop_assert!(spendable_balance(free, bonded, unbonding, w2) <= spendable_balance(free, bonded, unbonding, w1));
        }
    }

    /// Pins the on-chain storage-key layout assumption. If the
    /// `credits.referral_codes` map ever changes its hasher (e.g. from
    /// `Blake2_128Concat` to `Twox64Concat`) the prefix length changes
    /// and this test starts failing — that's the signal to update
    /// `REFERRAL_KEY_PREFIX_LEN` rather than ship `�`-corrupted codes
    /// to the UI again.
    #[test]
    fn extract_strips_pallet_storage_blake2_128_prefix() {
        let code = b"HIPPIUS6559825516876025567";
        let mut key_bytes = vec![0xAA; 16]; // twox_128(pallet_name)
        key_bytes.extend(std::iter::repeat(0xBB).take(16)); // twox_128(storage_name)
        key_bytes.extend(std::iter::repeat(0xCC).take(16)); // blake2_128(key)
        key_bytes.extend_from_slice(code);

        let recovered =
            extract_referral_code_bytes(&key_bytes).expect("non-empty key");
        assert_eq!(recovered, code);
        assert_eq!(REFERRAL_KEY_PREFIX_LEN, 48);
    }

    #[test]
    fn extract_returns_none_for_truncated_key() {
        // 47-byte key (one short of the deterministic prefix) — nothing
        // sensible to extract, so we expect None and the iteration
        // skips this entry instead of slicing into adjacent memory.
        let short = vec![0u8; REFERRAL_KEY_PREFIX_LEN - 1];
        assert!(extract_referral_code_bytes(&short).is_none());

        // Exactly 48 bytes — prefix with no raw key. Also None, since
        // an empty code isn't a valid referral row.
        let exact = vec![0u8; REFERRAL_KEY_PREFIX_LEN];
        assert!(extract_referral_code_bytes(&exact).is_none());
    }

    #[test]
    fn extract_handles_variable_length_codes() {
        // Reproduces the original bug: with a 26-byte code, the previous
        // implementation grabbed the LAST 32 bytes and ended up with
        // 6 hash bytes followed by the code. The new implementation
        // returns the full code regardless of length.
        for code in [
            b"HIPPIUS6559825516876025567".as_slice(),
            b"HIPPIUS16817098965507737959".as_slice(),
            b"HIPPIUS18099738829974267908".as_slice(),
        ] {
            let mut key = vec![0xFFu8; REFERRAL_KEY_PREFIX_LEN];
            key.extend_from_slice(code);
            assert_eq!(extract_referral_code_bytes(&key), Some(code));
        }
    }
}
