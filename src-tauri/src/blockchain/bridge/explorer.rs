//! Bridge explorer: read `AlphaBridge` deposit/withdrawal state + stats from the
//! Hippius chain, best-effort cross-ref the Bittensor contract, and derive
//! display statuses (`status.rs`). Replaces the TS `fetchBridgeDataOnChain`.
//! Read-only, no auth.
//!
//! The Bittensor cross-ref (`bittensor_side`) issues one contract dry-run per
//! row — exactly like the TS — and is best-effort: a failed read leaves the
//! field `None` and never fails the whole snapshot.

use subxt::ext::codec::Encode;
use subxt::utils::AccountId32;
use subxt::{OnlineClient, PolkadotConfig};

use super::runtime::hippius_tn::runtime_types::pallet_alpha_bridge::pallet::{Deposit, WithdrawalRequest};
use super::runtime::{bittensor, hippius_tn};
use super::types::{BridgeOnChainData, BridgeStats, DepositBittensorSide, DepositView, WithdrawalBittensorSide, WithdrawalView};
use super::{client, config, contract, convert, status};
use crate::error::{AppError, Result};

/// hAlpha (Hippius-side) decimals — both deposit (minted) and withdrawal
/// (burned) amounts are hAlpha rao.
const HALPHA_DECIMALS: u32 = 18;

fn se<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Substrate(e.to_string())
}

/// Hex of a Blake2_128Concat map key's raw key (the hasher appends it, so the
/// trailing 32 bytes are the `DepositId`/`WithdrawalRequestId`).
fn request_id_hex(key_bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(request_id_bytes(key_bytes)))
}

/// The raw 32-byte request id from a map key (trailing 32 bytes), for the
/// contract cross-ref argument. Short keys yield a zero-padded id.
fn request_id_bytes(key_bytes: &[u8]) -> [u8; 32] {
    let mut id = [0u8; 32];
    let start = key_bytes.len().saturating_sub(32);
    let tail = &key_bytes[start..];
    id[32 - tail.len()..].copy_from_slice(tail);
    id
}

/// Best-effort Bittensor-side deposit cross-ref. Returns `(raw_status, side)`.
async fn deposit_cross_ref(
    bt: &OnlineClient<PolkadotConfig>,
    contract: &AccountId32,
    origin: &AccountId32,
    id: &[u8; 32],
) -> Option<(String, DepositBittensorSide)> {
    let dr: Option<contract::DepositRequest> =
        contract::query_contract(bt, contract, origin.clone(), config::GET_DEPOSIT_REQUEST_SELECTOR, id.encode())
            .await
            .ok()?;
    let dr = dr?;
    let status = format!("{:?}", dr.status);
    let side = DepositBittensorSide {
        status: status.clone(),
        created_at_block: dr.created_at_block.to_string(),
        amount_display: convert::format_rao(u128::from(dr.amount), convert::ALPHA_DECIMALS),
        nonce: dr.nonce.to_string(),
    };
    Some((status, side))
}

/// Best-effort Bittensor-side withdrawal cross-ref. Returns `(raw_status,
/// vote_count, side)`.
async fn withdrawal_cross_ref(
    bt: &OnlineClient<PolkadotConfig>,
    contract: &AccountId32,
    origin: &AccountId32,
    id: &[u8; 32],
) -> Option<(String, u64, WithdrawalBittensorSide)> {
    let w: Option<contract::Withdrawal> = contract::query_contract(bt, contract, origin.clone(), config::GET_WITHDRAWAL_SELECTOR, id.encode())
        .await
        .ok()?;
    let w = w?;
    let status = format!("{:?}", w.status);
    let vote_count = u32::try_from(w.votes.len()).unwrap_or(u32::MAX);
    let side = WithdrawalBittensorSide {
        status: status.clone(),
        created_at_block: w.created_at_block.to_string(),
        amount_display: convert::format_rao(u128::from(w.amount), convert::ALPHA_DECIMALS),
        vote_count,
        finalized_at_block: w.finalized_at_block.map(|b| b.to_string()),
    };
    Some((status, u64::from(vote_count), side))
}

/// Build one `DepositView` from a Hippius `Deposit` row + its map key, including
/// the best-effort Bittensor cross-ref and the unified status.
async fn build_deposit(
    d: Deposit,
    key_bytes: &[u8],
    hippius_height: u64,
    bt: &OnlineClient<PolkadotConfig>,
    contract: &AccountId32,
    origin: &AccountId32,
) -> DepositView {
    let votes: Vec<String> = d.votes.iter().map(ToString::to_string).collect();
    let vote_count = u32::try_from(votes.len()).unwrap_or(u32::MAX);
    let raw_status = format!("{:?}", d.status);
    let id = request_id_bytes(key_bytes);
    let (bt_status, bittensor_side) = match deposit_cross_ref(bt, contract, origin, &id).await {
        Some((s, side)) => (Some(s), Some(side)),
        None => (None, None),
    };
    let unified = status::deposit_status(
        &raw_status,
        u64::from(vote_count),
        d.created_at_block,
        Some(hippius_height),
        bt_status.as_deref(),
    );
    DepositView {
        request_id: request_id_hex(key_bytes),
        recipient: d.recipient.to_string(),
        amount: d.amount.to_string(),
        amount_display: convert::format_rao(d.amount, HALPHA_DECIMALS),
        votes,
        vote_count,
        status: raw_status,
        unified_status: unified.to_string(),
        created_at_block: d.created_at_block.to_string(),
        finalized_at_block: d.finalized_at_block.map(|b| b.to_string()),
        bittensor_side,
    }
}

/// Build one `WithdrawalView` from a Hippius `WithdrawalRequest` row + its key.
async fn build_withdrawal(
    w: WithdrawalRequest,
    key_bytes: &[u8],
    hippius_height: u64,
    bt: &OnlineClient<PolkadotConfig>,
    contract: &AccountId32,
    origin: &AccountId32,
) -> WithdrawalView {
    let raw_status = format!("{:?}", w.status);
    let id = request_id_bytes(key_bytes);
    let (bt_status, bt_votes, bittensor_side) = match withdrawal_cross_ref(bt, contract, origin, &id).await {
        Some((s, v, side)) => (Some(s), v, Some(side)),
        None => (None, 0, None),
    };
    let unified = status::withdrawal_status(&raw_status, w.created_at_block, Some(hippius_height), bt_status.as_deref(), bt_votes);
    WithdrawalView {
        request_id: request_id_hex(key_bytes),
        sender: w.sender.to_string(),
        recipient: w.recipient.to_string(),
        amount: w.amount.to_string(),
        amount_display: convert::format_rao(w.amount, HALPHA_DECIMALS),
        status: raw_status,
        unified_status: unified.to_string(),
        created_at_block: w.created_at_block.to_string(),
        bittensor_side,
    }
}

/// A row is "in flight" for the stats while its unified status is pending or
/// processing.
fn is_in_flight(unified_status: &str) -> bool {
    unified_status == "pending" || unified_status == "processing"
}

/// Snapshot of on-chain bridge state for the history/explorer table.
///
/// # Errors
/// [`AppError::Substrate`] on any RPC/storage failure.
#[tauri::command]
pub async fn bridge_fetch_onchain_data() -> Result<BridgeOnChainData> {
    let hp = client::connect_hippius().await?;
    let bt = client::connect_bittensor().await?;
    let contract_addr: AccountId32 = config::BRIDGE_CONTRACT_ADDRESS
        .parse()
        .map_err(|e| AppError::Substrate(format!("invalid bridge contract address: {e:?}")))?;
    // Any account works as the dry-run origin for a read; reuse the contract's.
    let read_origin = contract_addr.clone();

    let hippius_height: u64 = hp
        .storage()
        .at_latest()
        .await
        .map_err(se)?
        .fetch(&hippius_tn::storage().system().number())
        .await
        .map_err(se)?
        .unwrap_or_default();
    let bittensor_height: u32 = bt
        .storage()
        .at_latest()
        .await
        .map_err(se)?
        .fetch(&bittensor::storage().system().number())
        .await
        .map_err(se)?
        .unwrap_or_default();

    let hp_storage = hp.storage().at_latest().await.map_err(se)?;

    let guardians: Vec<String> = hp_storage
        .fetch_or_default(&hippius_tn::storage().alpha_bridge().guardians())
        .await
        .map_err(se)?
        .into_iter()
        .map(|g| g.to_string())
        .collect();
    let approve_threshold: u16 = hp_storage
        .fetch_or_default(&hippius_tn::storage().alpha_bridge().approve_threshold())
        .await
        .map_err(se)?;
    let cleanup_ttl_blocks = hp_storage
        .fetch_or_default(&hippius_tn::storage().alpha_bridge().cleanup_ttl_blocks())
        .await
        .map_err(se)?
        .to_string();

    let mut deposits = Vec::new();
    let mut dep_iter = hp_storage.iter(hippius_tn::storage().alpha_bridge().deposits_iter()).await.map_err(se)?;
    while let Some(item) = dep_iter.next().await {
        let kv = item.map_err(se)?;
        deposits.push(build_deposit(kv.value, &kv.key_bytes, hippius_height, &bt, &contract_addr, &read_origin).await);
    }

    let mut withdrawals = Vec::new();
    let mut wd_iter = hp_storage
        .iter(hippius_tn::storage().alpha_bridge().withdrawal_requests_iter())
        .await
        .map_err(se)?;
    while let Some(item) = wd_iter.next().await {
        let kv = item.map_err(se)?;
        withdrawals.push(build_withdrawal(kv.value, &kv.key_bytes, hippius_height, &bt, &contract_addr, &read_origin).await);
    }

    let stats = BridgeStats {
        total_deposits: u32::try_from(deposits.len()).unwrap_or(u32::MAX),
        total_withdrawals: u32::try_from(withdrawals.len()).unwrap_or(u32::MAX),
        pending_deposits: u32::try_from(deposits.iter().filter(|d| is_in_flight(&d.unified_status)).count()).unwrap_or(u32::MAX),
        pending_withdrawals: u32::try_from(withdrawals.iter().filter(|w| is_in_flight(&w.unified_status)).count()).unwrap_or(u32::MAX),
        hippius_height,
        bittensor_height: u64::from(bittensor_height),
        approve_threshold,
        cleanup_ttl_blocks,
        guardians,
    };

    Ok(BridgeOnChainData {
        deposits,
        withdrawals,
        stats,
    })
}
