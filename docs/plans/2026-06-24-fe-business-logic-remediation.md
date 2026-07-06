# Frontend Business-Logic Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the 5 confirmed wallet/bridge business-logic violations out of TypeScript so every domain constant and token-math decision lives only in Rust `src-tauri/`, with the frontend reduced to a thin consumer of Rust-computed figures.

**Architecture:** Three structural fixes — (A) the `MAX_GAS_FEE_BUFFER_PLANCK` constant must exist only in `transfers.rs`; (B) the FE consumes a Rust-computed "available to act with" figure instead of re-deriving `free − locked − buffer`; (C) the FE calls the already-registered bridge IPCs (`bridge_min_transfers`, `bridge_estimate_fees`) instead of hardcoding fee/minimum constants. One new Rust command (`compute_available_to_bond`) and one new field on `BridgeBalances` are the only backend additions; everything else is deletion + rewiring.

**Tech Stack:** Rust (Tauri commands, `serde`, `u128` saturating arithmetic, `proptest`), TypeScript (Next.js static export, Jotai, TanStack Query, `@tauri-apps/api` `invoke`), vitest.

**Source:** `AUDIT_FE_BUSINESS_LOGIC_2026-06-24.md` (findings L-1, M-1..M-4).

---

## Pre-work: branch & ground rules

- `redesign`, `main`, `dev` are branch-protected (PR-only, CI `rust` + `frontend` must be green). Work on a feature branch off `redesign`:
  ```bash
  git fetch origin && git switch redesign && git pull --ff-only
  git switch -c fix/fe-business-logic-remediation
  ```
- Rust lives in `src-tauri/`; build/test with `SQLX_OFFLINE=true`.
- Never run `cargo fmt --all` (it churns unrelated files — format only touched files: `cargo fmt -- src/blockchain/transfers.rs ...`).
- Scope clippy to avoid the pre-existing bridge-test clippy noise on the base branch: lint normally but only treat **newly introduced** warnings as blocking.
- Commit after each task (imperative subject ≤72 chars, one logical change).

### Rust design plan (data-structures-first — honor before coding)

- **Types:** reuse the existing `MaxTransferable { planck: String, hip: String }` (`transfers.rs`, serde camelCase) for `compute_available_to_bond`. Add one field `h_alpha_bridgeable: String` to the existing `BridgeBalances` (`bridge/types.rs`). No new types.
- **Ownership/mutation:** both functions are pure, take owned `String` planck inputs, return owned structs. No shared state, no `&mut`, `Send`/`Sync` by construction.
- **Error strategy:** mirror `compute_max_transferable` — parse with `.unwrap_or(0)`, combine with `saturating_add`/`saturating_sub` (no `Result`; malformed input degrades to `0`, exactly matching today's FE `catch → 0n`). `MAX_GAS_FEE_BUFFER_PLANCK` is promoted to `pub(crate)` so it has a single owner.
- **Invariant:** `result_planck ≤ free` always; the figure saturates at `0`; it is monotonically non-increasing in `locked`. Pinned by a `proptest!` block.

---

## Task 1 (L-1): Delete the dead `calculateBridgeFee` / `calculateReceivedAmount` helpers

**Files:**
- Modify: `app/lib/bridge/config.ts:116-124` (delete the two exported helpers)

**Step 1: Verify they are dead**

Run: `rg -n "calculateBridgeFee|calculateReceivedAmount" app/`
Expected: hits ONLY inside `app/lib/bridge/config.ts` (the definitions + `calculateReceivedAmount` calling `calculateBridgeFee`). No other file references them.

**Step 2: Delete the helpers**

Remove lines 116-124 of `app/lib/bridge/config.ts`:
```ts
// Helper to calculate bridge fee
export function calculateBridgeFee(amount: bigint): bigint {
    const feePercentage = BRIDGE_CONFIG.fees.feePercentage;
    return (amount * BigInt(Math.floor(feePercentage * 10000))) / BigInt(10000);
}

// Helper to calculate received amount after fees
export function calculateReceivedAmount(amount: bigint): bigint {
    return amount - calculateBridgeFee(amount);
}
```
(Leave `feePercentage` in `BRIDGE_CONFIG.fees` for now — Task 2 removes it.)

**Step 3: Verify build + lint pass**

Run: `pnpm lint && pnpm build`
Expected: PASS (nothing referenced the deleted exports).

**Step 4: Commit**

```bash
git add app/lib/bridge/config.ts
git commit -m "remove dead bridge fee-math helpers (audit L-1)"
```

---

## Task 2 (M-4): Source bridge minimums from `bridge_min_transfers`; delete FE fee/minimum constants

**Context:** Only `minAlphaPlanck`/`minHalphaPlanck` of the FE `BridgeConfig` are actually consumed (`BridgeDialog.tsx:236-245`). `feeNumerator`/`feeDenominator`/`minBufferBps`/decimals/URLs have **no consumers** outside `useBridge.ts` (verified via `rg`). The Rust command `bridge_min_transfers` is already registered (`main.rs:357`) and returns `{ alpha, hAlpha }` rao strings.

**Files:**
- Modify: `app/lib/hooks/api/useBridge.ts` (replace `buildFeConfig`/`BridgeConfig` with a `bridge_min_transfers` query exposing `minTransfers`)
- Modify: `app/components/page-sections/wallet/BridgeDialog.tsx:233-245` (read minimums from the new shape)
- Modify: `app/lib/bridge/config.ts:52-73` (delete `fees` + `minimumTransfer`)

**Step 1: Add a `bridge_min_transfers` query to `useBridge`**

In `app/lib/hooks/api/useBridge.ts`, replace the `BridgeConfig` interface + `buildFeConfig` + `const config = useMemo(buildFeConfig, [])` with a query. Add near the other `useQuery` calls:
```ts
/** Per-direction minimum transfer (rao decimal strings), owned by Rust
 *  `convert.rs` and exposed via `bridge_min_transfers`. The FE renders the
 *  floor it gates input on; the chain enforces the real one (audit M-4). */
const minTransfersQuery = useQuery<{ alpha: string; hAlpha: string }>({
  queryKey: ["bridge-min-transfers"],
  queryFn: () => invoke("bridge_min_transfers"),
  staleTime: Infinity,
});
```
Delete the `BridgeConfig` interface (lines ~41-60), the `buildFeConfig` function (lines ~62-79), the `const config = useMemo(buildFeConfig, [])`, and the `import { BRIDGE_CONFIG } from "@/lib/bridge/config";` if nothing else in the file uses it (verify with `rg "BRIDGE_CONFIG" app/lib/hooks/api/useBridge.ts`).

In the hook's return object, replace `config` with `minTransfers: minTransfersQuery.data ?? null`.

**Step 2: Read minimums from the new shape in `BridgeDialog`**

In `app/components/page-sections/wallet/BridgeDialog.tsx`, change the `minAmountPlanck` memo (lines 233-245) from `bridge.config.minAlphaPlanck`/`minHalphaPlanck` to:
```ts
const minAmountPlanck = useMemo<bigint>(() => {
  const m = bridge.minTransfers;
  if (!m) return 0n;
  try {
    return BigInt(isAlphaToHAlpha ? m.alpha : m.hAlpha);
  } catch {
    return 0n;
  }
}, [bridge.minTransfers, isAlphaToHAlpha]);
```

**Step 3: Delete the FE fee/minimum constants**

In `app/lib/bridge/config.ts`, delete the entire `fees:` block (lines ~52-63) and the `minimumTransfer:` block (lines ~65-73). Keep `bittensor`/`hippius`/`hippiusTestnet`/`contract`/`defaultValidator`/`tokens`/`timing` (env-sourced endpoint/display config — legitimate FE config, not domain logic). Run `rg -n "BRIDGE_CONFIG.fees|BRIDGE_CONFIG.minimumTransfer" app/` and fix any remaining reader.

**Step 4: Verify build + lint + tests**

Run: `pnpm lint && pnpm build && pnpm test`
Expected: PASS. (tsc proves no dangling `bridge.config` / deleted-field reads remain.)

**Step 5: Commit**

```bash
git add app/lib/hooks/api/useBridge.ts app/components/page-sections/wallet/BridgeDialog.tsx app/lib/bridge/config.ts
git commit -m "source bridge minimums from bridge_min_transfers IPC (audit M-4)"
```

---

## Task 3 (M-3): Compute bridgeable hAlpha in Rust; remove the BridgeDialog buffer copy

**Approach (decision):** fold the buffer into `bridge_get_balances` by adding `h_alpha_bridgeable` to `BridgeBalances`. The balances are already fetched on every dialog open, so this needs **no extra round-trip** and the renderer never sees the buffer literal. `h_alpha` stays the raw free balance (used for the dest-side display in the alpha→halpha direction).

**Files:**
- Modify: `src-tauri/src/blockchain/transfers.rs:25` (promote `MAX_GAS_FEE_BUFFER_PLANCK` to `pub(crate)`)
- Modify: `src-tauri/src/blockchain/bridge/types.rs` (`BridgeBalances` — add `h_alpha_bridgeable`)
- Modify: `src-tauri/src/blockchain/bridge/queries.rs` (`bridge_get_balances` — compute the field; add a unit test)
- Modify: `app/lib/bridge/types.ts` (`BridgeBalances` — add `hAlphaBridgeable: bigint`)
- Modify: `app/lib/hooks/api/useBridge.ts` (map the new field)
- Modify: `app/components/page-sections/wallet/BridgeDialog.tsx:45,220-225` (delete the const; read `balances.hAlphaBridgeable`)

**Step 1: Write the failing Rust test**

In `src-tauri/src/blockchain/bridge/queries.rs`, add to `mod tests`:
```rust
#[test]
fn bridgeable_halpha_subtracts_one_gas_buffer() {
    use crate::blockchain::transfers::MAX_GAS_FEE_BUFFER_PLANCK;
    // 1 hAlpha free → free minus exactly one gas buffer, saturating at 0.
    let free: u128 = 1_000_000_000_000_000_000;
    assert_eq!(
        super::bridgeable_halpha(free),
        free - MAX_GAS_FEE_BUFFER_PLANCK
    );
    // Below the buffer saturates to 0, never underflows.
    assert_eq!(super::bridgeable_halpha(1), 0);
    assert_eq!(super::bridgeable_halpha(0), 0);
}
```

**Step 2: Run it to verify it fails**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo test bridgeable_halpha -- --nocapture`
Expected: FAIL — `bridgeable_halpha` not defined / `MAX_GAS_FEE_BUFFER_PLANCK` not public.

**Step 3: Implement**

In `src-tauri/src/blockchain/transfers.rs:25`, change visibility and update the doc's last sentence:
```rust
/// ... (existing doc) ... Promoted to `pub(crate)` so the bridge's
/// bridgeable-balance calc reuses the SAME buffer — the constant has one
/// owner (audit M-3).
pub(crate) const MAX_GAS_FEE_BUFFER_PLANCK: u128 = 10_000_000_000_000_000;
```

In `src-tauri/src/blockchain/bridge/types.rs`, add to `BridgeBalances`:
```rust
    /// Free hAlpha minus one gas buffer — the amount actually bridgeable
    /// hAlpha→Alpha. Computed in Rust so the renderer never re-derives the
    /// buffer (audit M-3). `h_alpha` stays the raw free balance for display.
    pub h_alpha_bridgeable: String,
```

In `src-tauri/src/blockchain/bridge/queries.rs`, add the pure helper above `bridge_get_balances`:
```rust
/// Free hAlpha minus one [`MAX_GAS_FEE_BUFFER_PLANCK`], saturating at 0 — the
/// hAlpha→Alpha bridgeable amount. Pure so it is unit-testable without a chain.
fn bridgeable_halpha(h_alpha_free: u128) -> u128 {
    h_alpha_free.saturating_sub(crate::blockchain::transfers::MAX_GAS_FEE_BUFFER_PLANCK)
}
```
And in `bridge_get_balances`, after `h_alpha` is computed, set the new field in the returned struct:
```rust
    Ok(BridgeBalances {
        alpha: alpha_free.to_string(),
        alpha_stake: alpha_stake.to_string(),
        h_alpha: h_alpha.to_string(),
        h_alpha_bridgeable: bridgeable_halpha(h_alpha).to_string(),
    })
```

**Step 4: Run the test to verify it passes**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo test bridgeable_halpha -- --nocapture`
Expected: PASS.

**Step 5: Wire the FE to the new field**

In `app/lib/bridge/types.ts`, add to `BridgeBalances`:
```ts
    /** Free hAlpha minus the gas buffer — Rust-computed bridgeable amount
     *  for hAlpha → Alpha (audit M-3). */
    hAlphaBridgeable: bigint;
```
In `app/lib/hooks/api/useBridge.ts` `balancesQuery`: extend the invoke result type with `hAlphaBridgeable: string`, map `hAlphaBridgeable: BigInt(b.hAlphaBridgeable)`, and add `hAlphaBridgeable: BigInt(0)` to the no-address default object.

In `app/components/page-sections/wallet/BridgeDialog.tsx`: delete the `MAX_GAS_FEE_BUFFER_PLANCK` const (lines 43-45) and change `sourceBalancePlanck` (lines 219-224) so the halpha→alpha branch reads the Rust figure:
```ts
  const sourceBalancePlanck = useMemo<bigint | null>(() => {
    if (!balances) return null;
    if (isAlphaToHAlpha) return balances.alphaStake > 0n ? balances.alphaStake : 0n;
    return balances.hAlphaBridgeable > 0n ? balances.hAlphaBridgeable : 0n;
  }, [balances, isAlphaToHAlpha]);
```

**Step 6: Verify Rust + FE**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo test && cd .. && pnpm lint && pnpm build`
Expected: PASS. Grep guard: `rg -n "10000000000000000|MAX_GAS_FEE_BUFFER_PLANCK" app/components/page-sections/wallet/BridgeDialog.tsx` → no hits.

**Step 7: Commit**

```bash
git add src-tauri/src/blockchain/transfers.rs src-tauri/src/blockchain/bridge/types.rs src-tauri/src/blockchain/bridge/queries.rs app/lib/bridge/types.ts app/lib/hooks/api/useBridge.ts app/components/page-sections/wallet/BridgeDialog.tsx
git commit -m "compute bridgeable hAlpha in Rust; drop FE gas-buffer copy (audit M-3)"
```

---

## Task 4 (M-1 + M-2): Add `compute_available_to_bond`; rewire StakeDialog

**Files:**
- Modify: `src-tauri/src/blockchain/transfers.rs` (new `compute_available_to_bond` command + unit test + proptest)
- Modify: `src-tauri/src/main.rs:64,366` (import + register the command)
- Modify: `app/components/page-sections/wallet/StakeDialog.tsx:34,81-100` (delete the const + the `useMemo`; source `availablePlanck` from Rust)

**Step 1: Write the failing Rust unit test**

In `src-tauri/src/blockchain/transfers.rs`, add a `#[cfg(test)] mod tests` (or extend it) with:
```rust
#[test]
fn available_to_bond_subtracts_locked_and_buffer() {
    // free=2 hAlpha, locked (bonded+unbonding+withdrawable)=0.5 hAlpha total.
    let r = compute_available_to_bond(
        "2000000000000000000".into(), // 2e18 free
        "300000000000000000".into(),  // 0.3 bonded
        "100000000000000000".into(),  // 0.1 unbonding
        "100000000000000000".into(),  // 0.1 withdrawable
    );
    // 2e18 - 0.5e18 - 1e16 buffer = 1_490_000_000_000_000_000.
    assert_eq!(r.planck, "1490000000000000000");
    // Locked exceeding free saturates to 0, never underflows.
    let zero = compute_available_to_bond(
        "1".into(), "5".into(), "0".into(), "0".into(),
    );
    assert_eq!(zero.planck, "0");
    // Malformed input degrades to 0 (matches the old FE catch → 0n).
    let bad = compute_available_to_bond(
        "abc".into(), "".into(), "x".into(), "0".into(),
    );
    assert_eq!(bad.planck, "0");
}
```

**Step 2: Run it to verify it fails**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo test available_to_bond -- --nocapture`
Expected: FAIL — `compute_available_to_bond` not defined.

**Step 3: Implement the command**

In `src-tauri/src/blockchain/transfers.rs`, after `compute_max_transferable`:
```rust
/// Available-to-bond amount for the "Stake Max" UX on the wallet page.
///
/// `free`/`bonded`/`unbonding`/`withdrawable` are planck decimal strings — the
/// exact shapes `get_account_balance` and `get_staking_info` already return.
/// Subtracts the pallet-locked balances AND [`MAX_GAS_FEE_BUFFER_PLANCK`]:
/// those plancks are already locked by the staking pallet, so a `bond` that
/// includes them is chain-rejected, and the buffer leaves gas for the bond plus
/// a later unbond/withdraw. Saturates at 0. Pure — the buffer constant and the
/// subtraction live in Rust so the renderer never re-derives the rule (audit
/// M-1); the FE only renders the returned figure.
#[tauri::command]
pub fn compute_available_to_bond(free: String, bonded: String, unbonding: String, withdrawable: String) -> MaxTransferable {
    let parse = |s: String| s.parse::<u128>().unwrap_or(0);
    let locked = parse(bonded).saturating_add(parse(unbonding)).saturating_add(parse(withdrawable));
    let available = parse(free).saturating_sub(locked).saturating_sub(MAX_GAS_FEE_BUFFER_PLANCK);
    let planck = available.to_string();
    let hip = crate::blockchain::convert::planck_to_hip_full(planck.clone());
    MaxTransferable { planck, hip }
}
```

**Step 4: Run the unit test to verify it passes**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo test available_to_bond -- --nocapture`
Expected: PASS.

**Step 5: Add a proptest pinning the invariants**

Ensure `proptest` is a dev-dependency (`rg -n "proptest" src-tauri/Cargo.toml`; the repo already uses it for `logs.rs`). Add to the same `mod tests`:
```rust
proptest::proptest! {
    /// The available figure never exceeds free, saturates at 0, and is
    /// monotonically non-increasing in locked — the staking-gate invariants.
    #[test]
    fn available_to_bond_invariants(free in 0u128..u128::MAX, b in 0u128..u128::MAX/4, u in 0u128..u128::MAX/4, w in 0u128..u128::MAX/4) {
        let r = compute_available_to_bond(free.to_string(), b.to_string(), u.to_string(), w.to_string());
        let got: u128 = r.planck.parse().unwrap();
        proptest::prop_assert!(got <= free);
        let more_locked = compute_available_to_bond(free.to_string(), (b.saturating_add(1)).to_string(), u.to_string(), w.to_string());
        let got2: u128 = more_locked.planck.parse().unwrap();
        proptest::prop_assert!(got2 <= got);
    }
}
```
Run: `cd src-tauri && SQLX_OFFLINE=true cargo test available_to_bond_invariants`
Expected: PASS.

**Step 6: Register the command**

In `src-tauri/src/main.rs:64`, extend the import:
```rust
use crate::blockchain::transfers::{compute_available_to_bond, compute_max_transferable};
```
(delete the now-duplicate standalone `use ... compute_max_transferable;` line). In the `generate_handler![]` list near line 366, add `compute_available_to_bond,` next to `compute_max_transferable,`.

Run: `cd src-tauri && SQLX_OFFLINE=true cargo build`
Expected: PASS.

**Step 7: Rewire StakeDialog**

In `app/components/page-sections/wallet/StakeDialog.tsx`:
- Delete the `MAX_GAS_FEE_BUFFER_PLANCK` const + its doc comment (lines 28-34).
- Replace the `availablePlanck` `useMemo` (lines 73-100, including the long explanatory comment) with a Rust-sourced state:
```ts
  const [availablePlanck, setAvailablePlanck] = useState<bigint>(0n);

  // Available HIP to bond is computed in Rust (audit M-1):
  //   free − bonded − unbonding − withdrawable − gas buffer
  // The buffer constant and the subtraction are owned by `transfers.rs`; the
  // renderer only renders the returned figure (BigInt planck end-to-end, R-26).
  useEffect(() => {
    let cancelled = false;
    const freeBI = balanceInfo?.data?.free;
    if (!freeBI) {
      setAvailablePlanck(0n);
      return;
    }
    const free = typeof freeBI === "bigint" ? freeBI : BigInt(String(freeBI));
    invoke<{ planck: string; hip: string }>("compute_available_to_bond", {
      free: free.toString(),
      bonded: stakingInfo.bonded || "0",
      unbonding: stakingInfo.unbonding || "0",
      withdrawable: stakingInfo.withdrawable || "0",
    })
      .then((res) => {
        if (!cancelled) setAvailablePlanck(BigInt(res.planck));
      })
      .catch(() => {
        if (!cancelled) setAvailablePlanck(0n);
      });
    return () => {
      cancelled = true;
    };
  }, [
    balanceInfo,
    stakingInfo.bonded,
    stakingInfo.unbonding,
    stakingInfo.withdrawable,
  ]);
```
`handlePercentClick`, `formattedAvailable`, and `isAmountValid` are unchanged — they keep operating on `availablePlanck` (now Rust-sourced), which resolves M-2 automatically.

**Step 8: Verify Rust + FE**

Run: `cd src-tauri && SQLX_OFFLINE=true cargo test && cd .. && pnpm lint && pnpm build`
Expected: PASS. Grep guard: `rg -n "10_000_000_000_000_000|MAX_GAS_FEE_BUFFER_PLANCK" app/components/page-sections/wallet/StakeDialog.tsx` → no hits.

**Step 9: Commit**

```bash
git add src-tauri/src/blockchain/transfers.rs src-tauri/src/main.rs app/components/page-sections/wallet/StakeDialog.tsx
git commit -m "compute available-to-bond in Rust; thin StakeDialog (audit M-1/M-2)"
```

---

## Task 5: Regression guard + final verification

**Files:**
- Create: `app/lib/bridge/__tests__/noDuplicatedDomainConstants.test.ts`

**Step 1: Write the guard test**

This pins the audit fix: the buffer literal, the staking buffer const, and the FE fee/minimum constants must never reappear in the wallet/bridge sources.
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("no duplicated wallet/bridge domain constants in the FE (audit M-1/M-3/M-4/L-1)", () => {
  it("the gas buffer literal lives only in Rust", () => {
    for (const f of [
      "app/components/page-sections/wallet/StakeDialog.tsx",
      "app/components/page-sections/wallet/BridgeDialog.tsx",
    ]) {
      const src = read(f);
      expect(src, `${f} must not redeclare the gas buffer`).not.toMatch(
        /MAX_GAS_FEE_BUFFER_PLANCK|10_?000_?000_?000_?000_?000/,
      );
    }
  });

  it("bridge fee % / minimum-transfer constants and dead fee helpers are gone", () => {
    const cfg = read("app/lib/bridge/config.ts");
    expect(cfg).not.toMatch(/feePercentage|minimumTransfer|calculateBridgeFee|calculateReceivedAmount/);
  });
});
```

**Step 2: Run the guard test**

Run: `pnpm test noDuplicatedDomainConstants`
Expected: PASS (Tasks 1-4 already removed every match). If it fails, a constant survived — fix the offending file, not the test.

**Step 3: Full verification sweep**

Run, expecting all PASS:
```bash
cd src-tauri && SQLX_OFFLINE=true cargo test && SQLX_OFFLINE=true cargo clippy --all-targets -- -D warnings 2>&1 | tail -20
cd .. && pnpm lint && pnpm test && pnpm build
```
Note: if `cargo clippy --all-targets` reports warnings in the pre-existing bridge **test** code untouched by this work, confirm via `git stash` that they predate the branch; only newly introduced warnings block.

**Step 4: Commit + open PR**

```bash
git add app/lib/bridge/__tests__/noDuplicatedDomainConstants.test.ts
git commit -m "add regression guard against FE domain-constant duplication"
git push -u origin fix/fe-business-logic-remediation
gh pr create --base redesign --title "Move wallet/bridge domain logic to Rust (FE business-logic audit)" --body "Implements AUDIT_FE_BUSINESS_LOGIC_2026-06-24.md findings L-1, M-1..M-4. The MAX_GAS_FEE_BUFFER_PLANCK buffer and bridge fee/minimum constants now live only in Rust; StakeDialog/BridgeDialog consume Rust-computed figures via compute_available_to_bond, the new BridgeBalances.h_alpha_bridgeable field, and the existing bridge_min_transfers IPC."
```

---

## Done-when

- `MAX_GAS_FEE_BUFFER_PLANCK` / the `10^16` literal appears only in `src-tauri/src/blockchain/transfers.rs` (`rg` across `app/` returns nothing).
- No bridge fee % or minimum-transfer constant remains in `app/`; the FE reads them from `bridge_min_transfers` / `bridge_estimate_fees`.
- `compute_available_to_bond` exists, is registered, unit-tested + proptest-pinned; StakeDialog and BridgeDialog hold no domain token-math.
- `cargo test`, `cargo clippy` (no new warnings), `pnpm lint`, `pnpm test`, `pnpm build` all green.

## Out of scope (documented, not fixed)

- `BridgeDialog.tsx:39 FEE_PERCENTAGE = 0.001` feeds a display-only "0.1%" footer string (audit-confirmed permitted display). Optionally render the fee from `bridge_estimate_fees` instead, but it gates nothing — not required.
- `SendBalanceDialog` float pre-check (audit note): non-authoritative hint, `validate_send_balance` is the real gate. Separate low-priority cleanup.
- Removing now-unused `BRIDGE_CONFIG` endpoint/contract/validator fields if `rg` proves them dead — bonus cleanup, verify before deleting.
