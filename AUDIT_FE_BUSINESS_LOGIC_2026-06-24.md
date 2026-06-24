# Frontend Business-Logic-in-TypeScript Audit — Hippius Desktop

**Date:** 2026-06-24
**Scope:** The `app/` Next.js/TypeScript frontend, audited against the project MUST-DO rule: business logic (data processing, state transitions, persistence, network/IPC, blockchain, crypto, sync, validation, domain rules) must live in the Rust `src-tauri/` backend; `app/` is UI/presentation/routing/user-interaction only and calls Rust via `invoke()`.
**Method:** 6 category-blind finder agents swept the whole frontend (persistence, network, crypto/blockchain, sync/domain, validation, components/pages); each candidate was adversarially verified by an independent agent that read the actual code and checked for an existing Rust home. 25 candidates → 5 confirmed violations, 20 rejected as correctly architected.

## 1. Summary

Five confirmed violations, all in the **wallet/bridge** surface and all of the same kind: **domain token math and domain constants computed or hardcoded in TypeScript** when an authoritative (or near-authoritative) Rust home already exists or is trivially addable.

| Severity | Count | Findings |
|----------|-------|----------|
| High     | 0     | — |
| Medium   | 4     | StakeDialog gas-buffer + bond-availability formula; StakeDialog percent-button availability dependency; BridgeDialog gas-buffer subtraction; bridge fee/minimum constants in `config.ts` |
| Low      | 1     | dead `calculateBridgeFee` / `calculateReceivedAmount` helpers |

**Headline themes:**

1. **A domain constant (`MAX_GAS_FEE_BUFFER_PLANCK = 10^16`) is hand-copied into three places** — `transfers.rs` (the real owner), `StakeDialog.tsx`, and `BridgeDialog.tsx` — each with a "keep in sync" comment that documents the fragility rather than fixing it.
2. **Domain "how much can the user stake/bridge" arithmetic is computed in the renderer** (free − locked − buffer), gating the MAX/50%/25% buttons and the submit button, when the chain + Rust are the real authority. The FE re-derives the rule instead of asking Rust for the figure.
3. **Bridge pricing and minimum-transfer thresholds are duplicated** as FE constants even though Rust already owns them *and already exposes them over registered IPC commands* (`bridge_min_transfers`, `bridge_estimate_fees`). One leftover copy is outright dead code.

No High-severity findings: in every case the actual on-chain submit path and the Rust validators remain the authoritative gate, so a FE/Rust divergence mis-sizes a convenience button or shows a wrong cap — a correctness/UX bug — rather than enabling an invalid on-chain action or losing funds. The pattern is nonetheless worth fixing because it is exactly the dual-source-of-truth drift the MUST-DO rule exists to prevent.

## 2. Findings by severity

### Medium

---

#### M-1 — `MAX_GAS_FEE_BUFFER_PLANCK` constant + bond-availability formula duplicated in StakeDialog
**File:** `app/components/page-sections/wallet/StakeDialog.tsx:34, 81-100`
**Dimension:** validation-rules

**What it does.** Line 34 redeclares `MAX_GAS_FEE_BUFFER_PLANCK = 10_000_000_000_000_000n` with an explicit "keep the two in sync" comment pointing at `src-tauri/src/blockchain/transfers.rs:25`. Lines 81-100 compute the bond-availability formula in BigInt: `availablePlanck = free − (bonded + unbonding + withdrawable) − gas buffer`, clamped to ≥ 0. That figure drives the percent-button amounts (line 117), the displayed "You have:" figure (lines 102-105, which is legitimately display), and — crucially — `isAmountValid` (lines 125-128) which gates the Stake button.

**Why it violates the rule.** This is genuine staking-pallet domain arithmetic: those plancks are pallet-locked, so a bond that includes them is chain-rejected. Computing the available-to-stake figure and gating an on-chain action on it is "blockchain / validation / token math used to decide an action," which the rule requires in Rust. It is *not* the display-only token math the rule permits.

**Existing Rust home.** Partial. `compute_max_transferable` (`transfers.rs:42`) owns the buffer constant and does `balance.saturating_sub(buffer)`, but it is the **transfer** max (no bonded/unbonding/withdrawable subtraction) used by SendBalanceDialog. `get_staking_info` (`queries.rs`) exposes bonded/unbonding/withdrawable. No Rust command composes the bond-available figure — that composition lives only in the FE.

**Fix.** Add a command in `transfers.rs` (or `staking.rs`), e.g. `compute_available_to_bond(free, bonded, unbonding, withdrawable) -> MaxTransferable`, that reuses the single `MAX_GAS_FEE_BUFFER_PLANCK` and does `free.saturating_sub(bonded+unbonding+withdrawable).saturating_sub(buffer)` in `u128`, returning both planck and a display HIP string. Register it in `main.rs`. Then delete the line-34 constant and the lines 81-100 `useMemo` from StakeDialog; `invoke("compute_available_to_bond", …)` and store the returned `planck`/`hip`. The percent math (`available * pct / 100`) and the `isAmountValid` `≤ available` check stay as pure pre-checks operating on the Rust-returned figure.

---

#### M-2 — Percent-button (MAX/50%/25%) logic depends on the FE-derived availability
**File:** `app/components/page-sections/wallet/StakeDialog.tsx:116-128`
**Dimension:** validation-rules

**What it does.** `handlePercentClick` computes `availablePlanck * BigInt(pct) / 100n` to fill the amount field; `isAmountValid` reuses `availablePlanck` to gate the Stake button.

**Why it violates the rule.** The percentage math and display truncation themselves are permitted presentation. The violation is the dependency: both rely on `availablePlanck`, the M-1 formula built from the duplicated buffer constant and locked-balance arithmetic. So the percent buttons and the submit gate inherit a FE-owned domain rule.

**Existing Rust home.** Same as M-1 — none composes the staking-available amount today.

**Fix.** Folded into M-1: once `availablePlanck` comes from the new Rust command, `handlePercentClick`'s `available * pct / 100n` + `formatUnitsTruncated` stays as pure display, and `isAmountValid`'s `≤ available` stays as a UI pre-check while the chain-side bond rejection remains authoritative. No separate change beyond M-1.

---

#### M-3 — `MAX_GAS_FEE_BUFFER_PLANCK` duplicated in BridgeDialog
**File:** `app/components/page-sections/wallet/BridgeDialog.tsx:45, 220-225`
**Dimension:** validation-rules

**What it does.** Line 45 hardcodes the same `10^16` buffer (third copy of the literal) with a comment that it "mirrors `MAX_GAS_FEE_BUFFER_PLANCK` in `transfers.rs`." For the hAlpha→Alpha direction, `sourceBalancePlanck = balances.hAlpha − MAX_GAS_FEE_BUFFER_PLANCK`. That value feeds `handlePercentClick` (line 268), the `isAmountValid` ceiling (line 285) which enables/disables the Bridge button, and the submit-time guard (line 303).

**Why it violates the rule.** The buffer subtraction decides how much the user may bridge — a domain outcome, not a rendered one. `bridge_get_balances` (`queries.rs:38`) returns raw hAlpha with no buffer applied server-side, so the subtraction happens only in the FE.

**Existing Rust home.** Yes. `compute_max_transferable` (`transfers.rs:42`, registered `main.rs:366`) already implements exactly the buffer subtraction the FE duplicates, but BridgeDialog does not call it.

**Fix.** Delete the FE constant (and the StakeDialog twin). Preferred: add/fold a bridge-specific source so the FE never sees the buffer — either a small `compute_bridgeable_halpha(halpha_planck) -> { planck, display }` in `transfers.rs`/`bridge/queries.rs`, or fold the buffer into `bridge_get_balances` so it returns an already-buffered "bridgeable hAlpha" field. (Alternative: reuse `compute_max_transferable` on `balances.hAlpha`.) BridgeDialog then reads `sourceBalancePlanck` from the invoke result and feeds it unchanged into `handlePercentClick`, `isAmountValid`, and the submit guard. The `10^16` literal must not appear in `app/`.

---

#### M-4 — Bridge fee percentage and minimum-transfer thresholds hardcoded in the FE
**File:** `app/lib/bridge/config.ts:52-73`
**Dimension:** validation-rules

**What it does.** `BRIDGE_CONFIG` hardcodes `feePercentage` (0.001 = 0.1%), `minimumTransfer.alpha` (15e9 rao), `minimumTransfer.hAlpha` (15e18 rao), `minAmount`, `maxAmount`, and `minimumBufferPercentage`. `useBridge.ts:62-79` (`buildFeConfig`) re-derives `feeNumerator`/`minAlphaPlanck`/`minHalphaPlanck`/`minBufferBps` from these; `BridgeDialog.tsx:235-245,281-302` uses the minimums to compute `isAmountValid` (gates submit) and the "Minimum bridge amount is…" toast.

**Why it violates the rule.** These are bridge pricing and minimum-transfer eligibility thresholds — domain rules used to gate an action in the FE. The in-code comment at line 233 even falsely claims they are "sourced from the Rust BridgeConfig" when they are in fact FE constants.

**Existing Rust home.** Yes, and already exposed. `convert.rs` owns `FEE_BPS=10`, `MIN_TRANSFER_ALPHA_RAO=15_000_000_000`, `MIN_TRANSFER_HALPHA_RAO=15_000_000_000_000_000_000`. These are surfaced by the registered IPC commands `bridge_min_transfers` and `bridge_estimate_fees` (`main.rs:356-357`) and hard-enforced before signing (`deposit.rs:78`, `withdraw.rs:40`). The FE simply does not call those commands.

**Fix.** No new command needed for the core values — the FE must consume the existing IPCs instead of duplicating. (1) In `useBridge.ts`, replace the hardcoded reads in `buildFeConfig` with a query that calls `bridge_min_transfers` for the minimums and `bridge_estimate_fees` for any displayed fee; remove `minimumTransfer`/`feePercentage` from `BRIDGE_CONFIG`. (2) `BridgeDialog.tsx` derives `minAmountPlanck` and `isAmountValid` from those IPC thresholds, keeping the FE check as a pure pre-submit hint while the real gate stays in `deposit.rs`/`withdraw.rs`. (3) The only FE-only value with no Rust source is `minimumBufferPercentage`/`minBufferBps` — drop it if unused, or add it to `convert.rs` and expose it via `bridge_min_transfers` if it must gate anything. Net: `config.ts` keeps only env-sourced endpoints/contract/decimals constants.

---

### Low

---

#### L-1 — Dead `calculateBridgeFee` / `calculateReceivedAmount` helpers
**File:** `app/lib/bridge/config.ts:116-124`
**Dimension:** validation-rules

**What it does.** Two pure functions encode the 0.1% bridge fee as integer basis-point math (`amount * floor(feePercentage*10000) / 10000`) and the user's net proceeds, using the hardcoded `FEE_PERCENTAGE`.

**Why it violates the rule (and why it's only Low).** This is fee math — a domain rule — that would belong in Rust. But the canonical Rust home already exists and is live: `convert.rs::bridge_fee` / `received_after_fee` (`FEE_BPS=10`, `BPS_DENOM=10000`) reimplement the exact integer math, are unit-tested to match the TS, and are consumed by the registered `bridge_estimate_fees` (`queries.rs:100`, `main.rs:356`). The deposit/withdraw submit path runs entirely in Rust, so no FE-decided outcome reaches the chain. And the helpers are **dead code** — a repo grep shows no caller in `app/` except `calculateReceivedAmount` calling `calculateBridgeFee`. The live drift risk is essentially nil today; this is leftover pre-port code.

**Existing Rust home.** Yes — `bridge_estimate_fees` backed by `convert::bridge_fee`/`received_after_fee`.

**Fix.** Delete the dead `calculateBridgeFee` / `calculateReceivedAmount` exports (and the now-unused `fees.feePercentage` field if nothing else reads it — verify with `rg`). When BridgeDialog needs to show the fee/received amount, call the already-shipped `bridge_estimate_fees` IPC and render its `{ bridge_fee, received_amount }` strings. No FE fee math, no new Rust command.

## 3. Themes & systemic patterns

The five findings collapse into three structural problems — and all live in one feature area (wallet/bridge token flows).

**Theme A — One domain constant, three owners.** `MAX_GAS_FEE_BUFFER_PLANCK` exists in `transfers.rs` (the genuine owner) and is hand-copied into both `StakeDialog.tsx` and `BridgeDialog.tsx`. The "keep in sync" comments are an admission that the architecture has no single source of truth for this value. The structural fix is not "update all three carefully" — it is "the constant must exist only in Rust, and the FE must receive any figure derived from it." (M-1, M-3.)

**Theme B — The FE re-derives a figure instead of asking for it.** Both dialogs compute "how much can the user act with" (free − locked − buffer) in the renderer. The backend already holds every input (`get_staking_info`, `bridge_get_balances`) and the constant; the missing piece is a Rust command that *composes* them into the final figure. The renderer should consume an authoritative number, not reconstruct the rule that produces it. This is the same shape as the already-correct SendBalanceDialog → `compute_max_transferable` delegation; the staking and bridge paths simply weren't migrated to it. (M-1, M-2, M-3.)

**Theme C — Duplicating rules that already have a Rust IPC.** The bridge fee and minimum-transfer thresholds are the worst case of the pattern: Rust not only owns the values, it *already exposes them over registered IPC commands* (`bridge_min_transfers`, `bridge_estimate_fees`) and hard-enforces them before signing — yet the FE hardcodes its own copies, and one copy is dead. This is pure migration debt: the Rust port shipped, the FE consumers were never switched over. (M-4, L-1.)

The unifying structural lesson: the boundary is correct everywhere the FE *submits* (every write goes through Rust + chain), but leaks at the *pre-flight UX layer* — the button-sizing and enable/disable gates re-implement domain rules to avoid a round-trip. The fix in every case is to make the FE a thin consumer of a Rust-computed figure, keeping the FE check only as a non-authoritative UI hint.

## 4. Recommended remediation order

1. **Delete the dead code (L-1) first.** Lowest risk, removes one of the three fee-constant copies immediately, and shrinks `config.ts` before the M-4 refactor touches it. Pure deletion, no behavior change.
2. **M-4 — switch the bridge config to the existing IPCs.** No new Rust is required; the commands already exist and are enforced. This removes the largest cluster of duplicated domain rules (fee + both minimums) and corrects the misleading "sourced from Rust" comment. Doing it second means the file is already trimmed by step 1.
3. **M-3 — remove the bridge gas-buffer copy.** Either reuse `compute_max_transferable` or add the small `compute_bridgeable_halpha` command / buffered `bridge_get_balances` field. This kills the second buffer copy.
4. **M-1 + M-2 — add `compute_available_to_bond` and rewire StakeDialog.** This needs the one genuinely new Rust command, so it is last. It kills the third (final) buffer copy, so after this step the `10^16` literal exists only in `transfers.rs`. M-2 is resolved automatically once `availablePlanck` is Rust-sourced.

Rationale: front-load the zero-risk deletion and the no-new-Rust IPC consumption (steps 1–2), then the two buffer-removal changes ordered by how much new Rust they need (step 3 can reuse an existing command; step 4 needs a new one). After step 4, `MAX_GAS_FEE_BUFFER_PLANCK` and every bridge/stake domain rule live solely in Rust.

## 5. Notable false positives

A number of candidates looked suspicious but are correctly architected, and reviewers should not re-flag them:

- **FE-local persistence wrappers** (`userPreferencesDb.ts`, `addressBookDb.ts`, `notificationsDb.ts`, `onboardingDb.ts`) are thin `invoke()` wrappers over Rust commands; the SQLite tables, owner-scoping, and all domain decisions live in Rust. The only FE code is JSON marshaling and UI-default fallbacks.
- **OAuth/session localStorage** (`wallet-auth-context.tsx`, `LoginForm.tsx`) is a deliberately *distrusted* client hint. The authoritative session is persisted by Rust (`complete_oauth_flow` → `auth_session_repo::upsert`), and `restore_session` re-validates the FE-supplied token against the DB, rebinds to the DB token, and directs the FE when to clear — Rust owns every validity/identity/expiry decision.
- **Pure presentation resolvers** documented as intentionally FE-only: `theme.ts` (must run pre-paint, pre-auth), `useZoom.ts` (webview page-zoom, clamp is UI bounds), `mergeUploadFeed.ts` (pure display feed dedup, mirrors Rust `trim_start_matches('/')`), `renameValidation.ts` (instant-feedback mirror of the authoritative `validate_new_name` in `files.rs`).
- **Display-only token math:** `formatPlanckToHip.ts`, `planckUnits.ts`, and the `FEE_PERCENTAGE * 100` info-footer string in `BridgeDialog.tsx` render values but gate nothing — the rule permits token math used purely for display.
- **`useCreditCheck.ts` / `useCreditsExhausted.ts` / `useBridge.ts`** delegate every decision to Rust (`check_action_eligibility`, the `hcfs_credits_exhausted` event, `bridge_*` submit commands); the FE only reads a Rust-computed boolean/enum and routes it to UI state.
- **`MnemonicBackupDialog.tsx`** `MIN_PASSWORD_LENGTH = 8` governs only a local button's enabled state for a local zip-encrypt; the Rust command it calls (`create_encrypted_backup`) enforces no password policy, so there is no shared source of truth being duplicated.
- **`SendBalanceDialog.tsx`** float "amount > available" check is a non-authoritative typed-input hint; the authoritative gate is Rust `validate_send_balance` (integer planck), invoked before the confirm dialog. (A low-priority cleanup would feed the hint the raw planck BigInt instead of a float-parsed display string, but it is not a placement violation.)
