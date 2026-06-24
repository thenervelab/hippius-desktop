import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Reads sources relative to the repo root. `pnpm test` runs vitest from the
// repo root, so process.cwd() is stable across machines/CI (unlike __dirname,
// which is undefined under the ESM test runner).
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// Pins the FE business-logic audit fix (AUDIT_FE_BUSINESS_LOGIC_2026-06-24.md):
// the wallet/bridge gas buffer and the bridge fee/minimum thresholds must live
// only in Rust. If any reappears in the renderer, the dual-source-of-truth drift
// the audit removed is back — fail loudly here rather than ship it.
describe("no duplicated wallet/bridge domain constants in the FE (audit M-1/M-3/M-4/L-1)", () => {
  it("the gas-fee buffer lives only in Rust, never in the wallet dialogs", () => {
    for (const f of [
      "app/components/page-sections/wallet/StakeDialog.tsx",
      "app/components/page-sections/wallet/BridgeDialog.tsx",
    ]) {
      const src = read(f);
      expect(src, `${f} must not redeclare the gas-fee buffer`).not.toMatch(
        /MAX_GAS_FEE_BUFFER_PLANCK|10_?000_?000_?000_?000_?000/,
      );
    }
  });

  it("bridge fee-% / minimum-transfer constants and dead fee helpers are gone from config", () => {
    const cfg = read("app/lib/bridge/config.ts");
    expect(cfg).not.toMatch(
      /feePercentage|minimumTransfer|calculateBridgeFee|calculateReceivedAmount/,
    );
  });
});
