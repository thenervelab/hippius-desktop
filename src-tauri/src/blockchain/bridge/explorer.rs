//! Bridge explorer: read `AlphaBridge` deposit/withdrawal state + stats from the
//! Hippius chain and derive display statuses (`status.rs`). Replaces the TS
//! `fetchBridgeDataOnChain`. Read-only, no auth.
//!
//! The Bittensor contract cross-ref (`bittensorSide` enrichment via the contract
//! `get_deposit_request`/`get_withdrawal` reads) is a documented follow-up — the
//! TS treats it as best-effort, and the primary explorer data is the Hippius
//! `AlphaBridge` state read here.

use super::runtime::{bittensor, hippius_tn};
use super::types::{BridgeOnChainData, BridgeStats, DepositView, WithdrawalView};
use super::{client, convert, status};
use crate::error::{AppError, Result};

/// hAlpha (Hippius-side) decimals — both deposit (minted) and withdrawal
/// (burned) amounts are hAlpha rao.
const HALPHA_DECIMALS: u32 = 18;

fn se<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Substrate(e.to_string())
}

/// The last 32 bytes of a Blake2_128Concat map key are the raw key (the hasher
/// appends it), so a 32-byte `DepositId`/`WithdrawalRequestId` is recoverable.
fn request_id_from_key(key_bytes: &[u8]) -> String {
    let start = key_bytes.len().saturating_sub(32);
    format!("0x{}", hex::encode(&key_bytes[start..]))
}

/// Snapshot of on-chain bridge state for the history/explorer table.
///
/// # Errors
/// [`AppError::Substrate`] on any RPC/storage failure.
#[tauri::command]
pub async fn bridge_fetch_onchain_data() -> Result<BridgeOnChainData> {
    let hp = client::connect_hippius().await?;
    let bt = client::connect_bittensor().await?;

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

    // Deposits.
    let mut deposits = Vec::new();
    let mut dep_iter = hp_storage.iter(hippius_tn::storage().alpha_bridge().deposits_iter()).await.map_err(se)?;
    while let Some(item) = dep_iter.next().await {
        let kv = item.map_err(se)?;
        let d = kv.value;
        let votes: Vec<String> = d.votes.iter().map(ToString::to_string).collect();
        let vote_count = u32::try_from(votes.len()).unwrap_or(u32::MAX);
        let raw_status = format!("{:?}", d.status);
        let unified = status::deposit_status(&raw_status, u64::from(vote_count), d.created_at_block, Some(hippius_height), None);
        deposits.push(DepositView {
            request_id: request_id_from_key(&kv.key_bytes),
            recipient: d.recipient.to_string(),
            amount: d.amount.to_string(),
            amount_display: convert::format_rao(d.amount, HALPHA_DECIMALS),
            votes,
            vote_count,
            status: raw_status,
            unified_status: unified.to_string(),
            created_at_block: d.created_at_block.to_string(),
            finalized_at_block: d.finalized_at_block.map(|b| b.to_string()),
        });
    }

    // Withdrawals.
    let mut withdrawals = Vec::new();
    let mut wd_iter = hp_storage.iter(hippius_tn::storage().alpha_bridge().withdrawal_requests_iter()).await.map_err(se)?;
    while let Some(item) = wd_iter.next().await {
        let kv = item.map_err(se)?;
        let w = kv.value;
        let raw_status = format!("{:?}", w.status);
        let unified = status::withdrawal_status(&raw_status, w.created_at_block, Some(hippius_height), None, 0);
        withdrawals.push(WithdrawalView {
            request_id: request_id_from_key(&kv.key_bytes),
            sender: w.sender.to_string(),
            recipient: w.recipient.to_string(),
            amount: w.amount.to_string(),
            amount_display: convert::format_rao(w.amount, HALPHA_DECIMALS),
            status: raw_status,
            unified_status: unified.to_string(),
            created_at_block: w.created_at_block.to_string(),
        });
    }

    let pending_deposits = deposits.iter().filter(|d| d.unified_status == "pending" || d.unified_status == "processing").count();
    let pending_withdrawals = withdrawals.iter().filter(|w| w.unified_status == "pending" || w.unified_status == "processing").count();

    let stats = BridgeStats {
        total_deposits: u32::try_from(deposits.len()).unwrap_or(u32::MAX),
        total_withdrawals: u32::try_from(withdrawals.len()).unwrap_or(u32::MAX),
        pending_deposits: u32::try_from(pending_deposits).unwrap_or(u32::MAX),
        pending_withdrawals: u32::try_from(pending_withdrawals).unwrap_or(u32::MAX),
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
