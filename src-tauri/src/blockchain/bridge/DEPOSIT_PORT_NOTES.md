# Bridge deposit-path port notes (stage 4)

**STATUS: implemented in `deposit.rs` (`bridge_alpha_to_halpha`), compile-verified
and registered.** ⚠️ FUNDS-CRITICAL and NOT runtime-validated — the dry-run
gas/storage handling and the contract submit MUST be smoke-tested against a
funded Bittensor-testnet wallet + live node before release.

This was de-risked against the chain source at `~/Source/thebrain`; the design
and the discovered generated type paths are recorded here for the reviewer.

### deposit_request_id — IMPLEMENTED (`extract_deposit_id`)
The id is an `#[ink(topic)]` on `DepositRequestCreated` (hashed into the event
topics, not the data), so rather than topic archaeology we decode the event's
first non-topic field — `deposit_nonce` — from `Contracts.ContractEmitted.data`
and map it back via the `get_deposit_request_id_by_nonce` contract read. Returns
`None` on any failure (tracking-only; never affects the successful deposit).
⚠️ The event-`data` decode assumes ink! v5 lays the non-topic fields
(`deposit_nonce`, `amount`) with no leading discriminant — VERIFY against a live
deposit on testnet.

### bittensor_side cross-ref — IMPLEMENTED (`explorer::*_cross_ref`)
`query_contract<T>` (`contract.rs`) drives the `get_deposit_request` /
`get_withdrawal` reads; the decoded `DepositRequest`/`Withdrawal` mirrors enrich
each explorer row (`bittensor_side`, `null` on a failed read). One dry-run per
row per refetch — same as the original TS.

### Remaining: testnet smoke test
Verify the deposit dry-run gas/storage values are sane, the contract call lands,
a real deposit is created, the recovered `deposit_request_id` matches, and the
explorer `bittensor_side` cross-ref decodes correctly.

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
