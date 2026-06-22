# Bridge deposit-path port notes (stage 4) — testnet-gated

The Alpha→hAlpha **deposit** path is the only part of the bridge not yet ported.
It is funds-critical and its on-chain semantics cannot be validated without a
funded Bittensor-testnet wallet + a live node, so it is intentionally left for a
focused session WITH testnet access rather than shipped compile-only. Everything
needed to implement it directly is captured below (all de-risked against the
chain source at `~/Source/thebrain`).

## Authoritative references
- ink! contract source: `thebrain/contracts/bridge/src/{lib,events,errors}.rs`.
- Working flow + assertions: `thebrain/contracts/bridge/integration-tests/src/tests/bridge.integration.test.ts` and `src/utils.ts` (`addProxy`, event helpers).
- Original TS impl being replaced: `app/lib/bridge/service.ts` (`bridgeAlphaToHalpha`, ~515-700).
- `deposit(amount: Balance, hotkey: AccountId) -> Result<DepositRequestId, Error>`, selector `0x2d10c9bd` (`bridge/config.rs::DEPOSIT_SELECTOR`).

## The 4-step flow (mirror service.ts + the integration test)
1. **add_proxy** — `bittensor::tx().proxy().add_proxy(MultiAddress::Id(contract), ProxyType::Any, 0)`; submit; ignore a `Duplicate` error. (Lets the contract stake on the caller's behalf.)
2. **dry-run** — typed runtime API `bittensor::apis().contracts_api().call(origin, dest=contract, value=0, gas_limit=None, storage_deposit_limit=None, input)` where `input = DEPOSIT_SELECTOR ++ scale(amount:u128) ++ scale(hotkey:AccountId32)`. Call via `client.runtime_api().at_latest().await?.call(dry).await?`.
   - On the returned `ContractExecResult`: if it reverted, decode the inner return bytes with `contract::describe_contract_error(...)` and surface the reason; else read `gas_required` (double it) and `storage_deposit`.
3. **submit** — `bittensor::tx().contracts().call(MultiAddress::Id(contract), 0, gas_limit, storage_deposit_limit, input)`; `sign_and_submit_then_watch_default(&signer)` + `wait_for_finalized_success()`.
4. **remove_proxy** — `proxy().remove_proxy(MultiAddress::Id(contract), ProxyType::Any, 0)`; best-effort (log on failure; the deposit already succeeded).
5. Extract `DepositRequestCreated.deposit_request_id` from the `Contracts.ContractEmitted` events (decode the contract event `data` against the ABI event layout).

## Exact generated type paths (extracted from `bittensor_metadata.scale`)
- ProxyType: `bittensor::runtime_types::subtensor_runtime_common::ProxyType::Any` (NOT under a `proxy` submodule).
- Weight: `bittensor::runtime_types::sp_weights::weight_v2::Weight { ref_time, proof_size }` — `double_weight` = saturating_mul(2) each.
- Dry-run storage: `pallet_contracts::primitives::StorageDeposit<u128>` (a `Charge`/`Refund` enum). `clampStorageDeposit` ⇒ `Charge(c) => Some(c)`, `Refund(_) => None`.
- `Contracts.call` storage_deposit_limit arg type: confirm against the generated signature (pallet-contracts version-dependent — likely `Option<Compact<u128>>`).
- Signer: reuse `crate::blockchain::helpers::get_signer_and_address(&state, &password)` (active wallet sr25519, works on Bittensor PolkadotConfig). Drop the FE `walletId`.

## Known correctness items
- **TS bug to NOT carry over:** `service.ts` listens for a `DepositMade` event that does not exist — the real event is `DepositRequestCreated` (field `deposit_request_id`).
- The ink! `Error` enum table is contested across sources — see `contract.rs` (uses chain `errors.rs` HEAD + always emits the raw index). Re-confirm against the DEPLOYED contract's ABI.

## After deposit lands (stage 5)
Register `bridge_alpha_to_halpha` in `main.rs`, rewire `app/lib/hooks/useBridge.ts` + `BridgeDialog.tsx` to `invoke` the Rust commands, emit step progress via `app.emit("bridge://step", …)`, then DELETE `app/lib/bridge/*` + the polkadot-api deps, and audit whether `local_wallet_sign` still has any caller (delete if not — closes the blind-signing surface).
