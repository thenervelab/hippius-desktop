//! Tauri IPC commands — the public surface the frontend talks to.
//!
//! Every command operates under the auth account id derived via
//! `account_key(current_account_id())` so a logged-out caller can't
//! enumerate another user's bridge history.

use std::str::FromStr;

use crate::app_state::AppState;
use crate::auth::account_key::account_key;
use crate::blockchain::client::get_substrate_client;
use crate::blockchain::helpers::get_signer_and_address;
use crate::blockchain::runtime::custom_runtime;
use crate::bridge::cache;
use crate::bridge::config::{BridgeConfig, HALPHA_DECIMALS};
use crate::bridge::types::{
    BridgeDirection, BridgeStatus, BridgeStep, BridgeStepState, BridgeSubmitResult,
    TrackedBridgeTransaction,
};
use crate::error::{AppError, NotReadyKind};
use chrono::Utc;
use subxt::utils::AccountId32;
use tauri::{AppHandle, Emitter};
use tracing::info;

/// Tauri event names. Centralised so the frontend listener uses the
/// same constants — drift between the two would silently miss
/// progress updates.
pub const BRIDGE_STEP_EVENT: &str = "hippius_bridge_step";
pub const BRIDGE_TX_UPDATED_EVENT: &str = "hippius_bridge_tx_updated";

/// Resolve the auth account key. Maps "no session" to the unified
/// `NotReady(SigningKeyUnavailable)` so the FE drops into the
/// onboarding flow rather than showing a generic error.
fn owner_key(state: &AppState) -> Result<String, AppError> {
    let account_id = state
        .current_account_id()
        .map_err(|_| AppError::NotReady(NotReadyKind::SigningKeyUnavailable))?;
    Ok(account_key(&account_id))
}

/// Push a step update to the frontend wizard. Errors are logged but
/// not surfaced — losing one event must not abort the bridge flow.
fn emit_step(app: &AppHandle, steps: &[BridgeStep]) {
    if let Err(e) = app.emit(BRIDGE_STEP_EVENT, steps) {
        tracing::warn!("emit {BRIDGE_STEP_EVENT} failed: {e}");
    }
}

/// Push a transaction-updated event so the FE can refresh the row in
/// the bridge history table without re-querying the IPC.
fn emit_tx_updated(app: &AppHandle, tx: &TrackedBridgeTransaction) {
    if let Err(e) = app.emit(BRIDGE_TX_UPDATED_EVENT, tx) {
        tracing::warn!("emit {BRIDGE_TX_UPDATED_EVENT} failed: {e}");
    }
}

/// Frontend bootstrap — returns endpoints, contract address, fees,
/// minimums, decimals. The dialog calls this once on mount.
#[tauri::command]
pub fn bridge_get_config() -> BridgeConfig {
    BridgeConfig::current()
}

/// List every tracked bridge transaction for the auth user, newest
/// first. The frontend merges this with the live indexer feed.
#[tauri::command]
pub async fn bridge_get_transactions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TrackedBridgeTransaction>, AppError> {
    let owner = owner_key(&state)?;
    let pool = state.pool()?;
    cache::list(pool, &owner).await
}

/// Submit a hAlpha → Alpha bridge transaction.
///
/// 1. Verify the wallet password + load the signer.
/// 2. Parse the recipient SS58 into a Bittensor coldkey AccountId32.
/// 3. Insert a pending row into `bridge_transactions`.
/// 4. Emit `step 1/1 active` so the FE renders a progress chip.
/// 5. Sign + submit `AlphaBridge::burn_alpha_for_bridge` on Hippius —
///    the runtime burns the user's hAlpha and emits an
///    `AlphaBurnPending` event keyed by a burn nonce.
/// 6. Record the tx hash and emit `step 1/1 done`.
///
/// Guardians pick the burn request up off-chain and finalize the Alpha
/// release via `confirm_and_finalize_burn` — the FE polls / subscribes
/// for that event separately.
#[tauri::command]
pub async fn bridge_submit_halpha_to_alpha(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    amount: String,
    recipient_address: String,
    password: String,
) -> Result<BridgeSubmitResult, AppError> {
    let (signer, sender_address) = get_signer_and_address(&state, &password).await?;
    let client = get_substrate_client(&state).await?;
    let owner = owner_key(&state)?;
    let pool = state.pool()?.clone();

    let amount_planck: u128 = amount
        .parse()
        .map_err(|e| AppError::Other(format!("Invalid amount: {e}")))?;

    // The runtime takes the Bittensor coldkey as a `T::AccountId` —
    // same 32-byte representation as a Substrate SS58 address. The
    // user's bridge dialog enters the *destination* coldkey; we parse
    // it once here so a bad address fails before any state mutation.
    let bittensor_coldkey = AccountId32::from_str(&recipient_address)
        .map_err(|e| AppError::Validation(format!("Invalid recipient (Bittensor coldkey): {e:?}")))?;

    // `burn_alpha_for_bridge` takes the signer's own address explicitly
    // (the pallet uses it as the key on `AlphaBurnPending` so guardians
    // can index burns by user without re-deriving from the origin).
    // The signer is the only account that can authorise this call, so
    // it must match `sender_address` — which it does by construction
    // here since `get_signer_and_address` returns the active wallet's
    // pair.
    let user_account_id = AccountId32::from_str(&sender_address).map_err(|e| {
        AppError::Other(format!(
            "Active wallet address is not a valid AccountId32 ({sender_address}): {e:?}"
        ))
    })?;

    // Client-supplied dedupe nonce. The pallet stores it on
    // `AlphaBurnPending` and rejects duplicates via `DoubleSpendDetected`,
    // so any monotonically-unique value works; a 128-bit random draw
    // makes collisions vanishingly unlikely.
    let nonce: u128 = {
        use rand::RngCore;
        let mut buf = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut buf);
        u128::from_be_bytes(buf)
    };

    let tx_id = cache::generate_id();
    let now_ms = Utc::now().timestamp_millis();
    let tracked = TrackedBridgeTransaction {
        id: tx_id.clone(),
        direction: BridgeDirection::HalphaToAlpha.as_str().to_string(),
        status: BridgeStatus::Pending.as_str().to_string(),
        amount: amount_planck.to_string(),
        amount_decimals: HALPHA_DECIMALS,
        sender_address: sender_address.clone(),
        recipient_address: recipient_address.clone(),
        source_tx_hash: None,
        destination_tx_hash: None,
        deposit_id: None,
        // Stash the nonce as the withdrawal id so the FE can correlate
        // the eventual `AlphaBurnPending` / `BurnFinalized` events
        // without scraping the tx hash.
        withdrawal_id: Some(nonce.to_string()),
        created_at: now_ms,
        updated_at: now_ms,
        error: None,
        attestations: 0,
        required_attestations: 3,
        events: vec![crate::bridge::types::BridgeTransactionEvent {
            kind: "Submitted".to_string(),
            timestamp: now_ms,
            message: "Bridge withdrawal initiated".to_string(),
            data: None,
        }],
        denial_reason: None,
        refunded: false,
    };
    cache::insert(&pool, &owner, &tracked).await?;
    emit_tx_updated(&app, &tracked);

    // Wizard step. hAlpha → Alpha is a single extrinsic on the
    // Hippius side; guardian processing happens off-chain and is
    // surfaced later via the indexer.
    let mut steps = vec![BridgeStep {
        step: 1,
        label: "Submit Withdrawal".to_string(),
        detail: "Signing and submitting on Hippius…".to_string(),
        state: BridgeStepState::Active,
    }];
    emit_step(&app, &steps);

    info!("Submitting AlphaBridge::burn_alpha_for_bridge transaction (nonce={nonce})…");
    let tx_payload = custom_runtime::tx()
        .alpha_bridge()
        .burn_alpha_for_bridge(amount_planck, bittensor_coldkey, user_account_id, nonce);
    let submit_result = client
        .tx()
        .sign_and_submit_then_watch_default(&tx_payload, &signer)
        .await;
    let progress = match submit_result {
        Ok(p) => p,
        Err(e) => {
            let msg = format!("Submit failed: {e}");
            cache::set_status(&pool, &owner, &tx_id, BridgeStatus::Failed.as_str(), Some(&msg)).await?;
            steps[0].state = BridgeStepState::Error;
            steps[0].detail = msg.clone();
            emit_step(&app, &steps);
            return Err(AppError::Other(msg));
        }
    };
    let finalized = match progress.wait_for_finalized_success().await {
        Ok(f) => f,
        Err(e) => {
            let msg = format!("Withdrawal failed: {e}");
            cache::set_status(&pool, &owner, &tx_id, BridgeStatus::Failed.as_str(), Some(&msg)).await?;
            steps[0].state = BridgeStepState::Error;
            steps[0].detail = msg.clone();
            emit_step(&app, &steps);
            return Err(AppError::Other(msg));
        }
    };
    let tx_hash = format!("{:?}", finalized.extrinsic_hash());
    cache::set_source_tx_hash(&pool, &owner, &tx_id, &tx_hash).await?;
    cache::set_status(&pool, &owner, &tx_id, BridgeStatus::Confirmed.as_str(), None).await?;

    steps[0].state = BridgeStepState::Done;
    steps[0].detail = format!("Withdrawal submitted ({tx_hash})");
    emit_step(&app, &steps);

    // Re-emit the row so the history table picks up the new hash +
    // confirmed status without a manual refresh.
    if let Ok(rows) = cache::list(&pool, &owner).await {
        if let Some(updated) = rows.into_iter().find(|t| t.id == tx_id) {
            emit_tx_updated(&app, &updated);
        }
    }

    info!("AlphaBridge::burn_alpha_for_bridge tx finalized: {tx_hash}");
    Ok(BridgeSubmitResult {
        bridge_transaction_id: tx_id,
        tx_hash,
    })
}

/// Submit an Alpha → hAlpha bridge transaction.
///
/// Currently returns a structured "not yet implemented" error — this
/// direction needs:
///   1. Bittensor chain metadata generated via
///      `subxt-cli metadata --url wss://test.finney.opentensor.ai:443
///       > src-tauri/bittensor-metadata.scale`, plus a new
///      `#[subxt::subxt(runtime_metadata_path = …)]` module so the
///      generated `Proxy::add_proxy` / `Contracts::call` /
///      `Contracts::call_dry_run` calls are typed.
///   2. The AlphaEscrow ink! contract's metadata JSON (the ABI). The
///      `deposit` method selector (4-byte blake2 hash of the method
///      signature) and arg layout need to come from there so we can
///      hand-encode the `data` blob for `Contracts::call`.
///   3. Step orchestration mirroring web's 4-step flow:
///      add_proxy → dry_run → call → remove_proxy.
///
/// Until those land, the FE renders an explanatory message and the
/// Alpha → hAlpha submit button stays disabled.
#[tauri::command]
pub async fn bridge_submit_alpha_to_halpha(
    _state: tauri::State<'_, AppState>,
    _app: AppHandle,
    _amount: String,
    _hotkey: Option<String>,
    _password: String,
) -> Result<BridgeSubmitResult, AppError> {
    Err(AppError::Other(
        "Alpha → hAlpha bridging is not yet wired in the desktop app. \
         Needs Bittensor chain metadata and the AlphaEscrow ink! ABI; \
         see src-tauri/src/bridge/commands.rs."
            .to_string(),
    ))
}

