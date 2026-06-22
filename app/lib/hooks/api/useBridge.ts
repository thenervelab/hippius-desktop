"use client";

import { useCallback, useMemo, useState } from "react";
import { useSetAtom } from "jotai";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { bridgeInFlightAtom } from "@/lib/global-atoms/bridgeAtoms";

import { invoke } from "@tauri-apps/api/core";

// All bridge logic now lives in the Rust backend. Reads (balances, staked
// hotkeys) go through `bridge_get_*` IPC; the funds-critical WRITE paths
// (deposit/withdraw) go through `bridge_alpha_to_halpha` /
// `bridge_halpha_to_alpha` so the wallet never blind-signs a renderer-built
// extrinsic (audit H-8). The old TS bridge service / local cache are gone.
import { BRIDGE_CONFIG } from "@/lib/bridge/config";
import type {
  BridgeBalances,
  BridgeStep,
  StakedHotkey,
} from "@/lib/bridge/types";

export type { BridgeBalances, StakedHotkey } from "@/lib/bridge/types";

/** Mirror of the Rust `BridgeOutcome` (serde camelCase). */
interface BridgeOutcome {
  txHash: string;
  withdrawalId?: string | null;
  depositId?: string | null;
  success: boolean;
}

import { useLocalWallet } from "@/app/contexts/LocalWalletContext";

/**
 * Mirror of the Rust `BridgeConfig` shape the legacy dialog code reads.
 * Sourced from {@link BRIDGE_CONFIG} so the FE has a single source of
 * truth and we don't need a round-trip to Rust just to render config.
 */
export interface BridgeConfig {
  bittensorWsUrl: string;
  bittensorName: string;
  hippiusWsUrl: string;
  hippiusName: string;
  bridgeContractAddress: string;
  defaultValidatorHotkey: string;
  defaultNetuid: number;
  alphaDecimals: number;
  halphaDecimals: number;
  feeNumerator: number;
  feeDenominator: number;
  minAlphaPlanck: string;
  minHalphaPlanck: string;
  minBufferBps: number;
}

function buildFeConfig(): BridgeConfig {
  return {
    bittensorWsUrl: BRIDGE_CONFIG.bittensor.wsUrl,
    bittensorName: BRIDGE_CONFIG.bittensor.name,
    hippiusWsUrl: BRIDGE_CONFIG.hippius.wsUrl,
    hippiusName: BRIDGE_CONFIG.hippius.name,
    bridgeContractAddress: BRIDGE_CONFIG.contract.address,
    defaultValidatorHotkey: BRIDGE_CONFIG.defaultValidator.hotkey,
    defaultNetuid: BRIDGE_CONFIG.defaultValidator.netuid,
    alphaDecimals: BRIDGE_CONFIG.tokens.alpha.decimals,
    halphaDecimals: BRIDGE_CONFIG.tokens.hAlpha.decimals,
    feeNumerator: Math.round(BRIDGE_CONFIG.fees.feePercentage * 10000),
    feeDenominator: 10000,
    minAlphaPlanck: BRIDGE_CONFIG.minimumTransfer.alpha.toString(),
    minHalphaPlanck: BRIDGE_CONFIG.minimumTransfer.hAlpha.toString(),
    minBufferBps: Math.round(BRIDGE_CONFIG.fees.minimumBufferPercentage * 10000),
  };
}

export type { BridgeDirection } from "@/lib/bridge/types";

export interface BridgeSubmitResult {
  bridgeTransactionId: string;
  txHash: string;
}

const BALANCES_KEY = "bridge-balances";

/**
 * Top-level bridge hook used by the wallet dialog + history table.
 *
 * Reads (balances, staked hotkeys, transactions) still use the TS bridge
 * service's polkadot-api queries against the testnet endpoints.
 *
 * Submissions go through Rust IPC — `bridge_alpha_to_halpha` /
 * `bridge_halpha_to_alpha` construct, sign (with the active wallet), and submit
 * the extrinsics entirely in the backend. The renderer no longer builds an
 * extrinsic for the wallet to blind-sign (audit H-8); it sends only
 * `{amount, recipient/hotkey, password}`. Porting the read paths to Rust and
 * deleting the TS service is the remaining cleanup.
 */
export function useBridge() {
  const { activeWallet } = useLocalWallet();
  const queryClient = useQueryClient();
  const setBridgeInFlight = useSetAtom(bridgeInFlightAtom);

  const address = activeWallet?.address ?? null;

  // Bridge is "initialized" whenever an active wallet address is known —
  // there is no renderer-side chain connection to establish anymore
  // (the backend owns all chain I/O), so readiness is purely "do we have
  // an address to scope queries to".
  const isInitialized = !!address;

  const [wizardSteps] = useState<BridgeStep[]>([]);

  const config = useMemo(buildFeConfig, []);

  /* ── Balances ─────────────────────────────────────────────────────── */

  const balancesQuery = useQuery<BridgeBalances>({
    queryKey: [BALANCES_KEY, address],
    queryFn: async () => {
      if (!address) {
        return { alpha: BigInt(0), alphaStake: BigInt(0), hAlpha: BigInt(0) };
      }
      // Rust returns decimal rao *strings*; map to bigint so the dialog
      // does exact arithmetic (preserves the existing BridgeBalances shape).
      const b = await invoke<{
        alpha: string;
        alphaStake: string;
        hAlpha: string;
      }>("bridge_get_balances", { address });
      return {
        alpha: BigInt(b.alpha),
        alphaStake: BigInt(b.alphaStake),
        hAlpha: BigInt(b.hAlpha),
      };
    },
    enabled: !!address,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 2,
  });

  /* ── Staked hotkeys (for the Alpha → hAlpha direction picker) ─────── */

  const stakedHotkeysQuery = useQuery<StakedHotkey[]>({
    queryKey: ["bridge-staked-hotkeys", address],
    queryFn: async () => {
      if (!address) return [];
      const rows = await invoke<{ hotkey: string; stake: string }[]>(
        "bridge_get_staked_hotkeys",
        { address },
      );
      return rows.map((r) => ({ hotkey: r.hotkey, stake: BigInt(r.stake) }));
    },
    enabled: !!address,
    staleTime: 30_000,
  });

  /* ── Transaction refetch ──────────────────────────────────────────── */
  //
  // The history table owns the persisted bridge-transaction list + the
  // on-chain explorer data via its own queries; after a successful submit
  // we just invalidate both so they refetch.
  const refetchTransactions = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["bridge-explorer-data"] });
    await queryClient.invalidateQueries({ queryKey: ["bridge-tx-list"] });
  }, [queryClient]);

  /* ── Wizard steps ────────────────────────────────────────────────── */
  //
  // Step progress was emitted by the old in-renderer multi-op submit; the
  // backend now drives the whole transfer in one IPC, so the wizard array
  // stays empty and `clearWizardSteps` is a no-op kept for API stability
  // (the dialog still calls it to reset between opens).
  const clearWizardSteps = useCallback(() => {}, []);

  /* ── Submit: hAlpha → Alpha ──────────────────────────────────────── */

  const submitHalphaToAlpha = useCallback(
    async (params: {
      amount: string;
      recipientAddress: string;
      password: string;
    }): Promise<BridgeSubmitResult> => {
      if (!activeWallet) {
        throw new Error("No active wallet — create or unlock one first.");
      }

      // Bracket the entire submit in a refcount the idle-lock checks
      // so a long submit (slow testnet block production) doesn't
      // silently flip the soft-lock state mid-flight. `try/finally`
      // is the only place we touch the counter — the closure-scoped
      // password stays valid for every sign regardless, so a missed
      // decrement would only leak the "unlocked" flag, not any
      // secret material.
      setBridgeInFlight((c) => c + 1);
      try {
        // Construct + sign + submit in Rust — the wallet password never builds
        // a renderer-side extrinsic (audit H-8). amount is a rao decimal string.
        const outcome = await invoke<BridgeOutcome>("bridge_halpha_to_alpha", {
          amount: params.amount,
          recipient: params.recipientAddress || null,
          password: params.password,
        });

        void queryClient.invalidateQueries({ queryKey: [BALANCES_KEY] });
        void refetchTransactions();

        return {
          bridgeTransactionId: outcome.withdrawalId ?? "",
          txHash: outcome.txHash ?? "",
        };
      } finally {
        setBridgeInFlight((c) => Math.max(0, c - 1));
      }
    },
    [activeWallet, queryClient, refetchTransactions, setBridgeInFlight],
  );

  /* ── Submit: Alpha → hAlpha ──────────────────────────────────────── */

  const submitAlphaToHalpha = useCallback(
    async (params: {
      amount: string;
      hotkey?: string;
      password: string;
    }): Promise<BridgeSubmitResult> => {
      if (!activeWallet) {
        throw new Error("No active wallet — create or unlock one first.");
      }

      // See submitHalphaToAlpha for the refcount rationale. Alpha →
      // hAlpha is the longer of the two paths (4 chain ops) so this
      // matters more here in practice.
      setBridgeInFlight((c) => c + 1);
      try {
        // 4-step deposit constructed + signed + submitted in Rust (audit H-8).
        const outcome = await invoke<BridgeOutcome>("bridge_alpha_to_halpha", {
          amount: params.amount,
          hotkey: params.hotkey ?? null,
          password: params.password,
        });

        void queryClient.invalidateQueries({ queryKey: [BALANCES_KEY] });
        void refetchTransactions();

        return {
          bridgeTransactionId: outcome.depositId ?? "",
          txHash: outcome.txHash ?? "",
        };
      } finally {
        setBridgeInFlight((c) => Math.max(0, c - 1));
      }
    },
    [activeWallet, queryClient, refetchTransactions, setBridgeInFlight],
  );

  return useMemo(
    () => ({
      // Config + readiness
      config,
      configLoading: false,
      isInitialized,

      // Balances
      balances: balancesQuery.data,
      balancesLoading:
        balancesQuery.isLoading || (!balancesQuery.data && !!address && isInitialized),
      balancesFetching: balancesQuery.isFetching,
      refetchBalances: balancesQuery.refetch,

      // Hotkeys (Alpha → hAlpha picker)
      stakedHotkeys: stakedHotkeysQuery.data ?? [],
      stakedHotkeysLoading: stakedHotkeysQuery.isLoading,
      refetchStakedHotkeys: stakedHotkeysQuery.refetch,

      // Transactions — owned by the history table's own queries; this is
      // just the invalidation trigger fired after a successful submit.
      refetchTransactions,

      // Wizard steps
      wizardSteps,
      clearWizardSteps,

      // Operations
      submitHalphaToAlpha,
      submitAlphaToHalpha,
    }),
    [
      config,
      isInitialized,
      balancesQuery.data,
      balancesQuery.isLoading,
      balancesQuery.isFetching,
      balancesQuery.refetch,
      stakedHotkeysQuery.data,
      stakedHotkeysQuery.isLoading,
      stakedHotkeysQuery.refetch,
      refetchTransactions,
      wizardSteps,
      clearWizardSteps,
      submitHalphaToAlpha,
      submitAlphaToHalpha,
      address,
    ],
  );
}

/**
 * Format a smallest-unit BigInt-ish value as a display number using
 * `decimals`. Truncates (never rounds up) to `displayDecimals` so the
 * displayed value never appears to exceed the underlying balance.
 *
 * Accepts string | bigint | undefined so old call sites that passed
 * `planck` strings keep working.
 */
export function formatBridgeAmount(
  planck: string | bigint | undefined,
  decimals: number,
  displayDecimals = 6,
): string {
  if (planck === undefined || planck === null) return "0";
  try {
    const value = typeof planck === "bigint" ? planck : BigInt(String(planck));
    if (value <= BigInt(0)) return "0";
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = value / divisor;
    const frac = value % divisor;
    if (frac === BigInt(0)) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, "0");
    const trimmedFrac = fracStr.slice(0, displayDecimals).replace(/0+$/, "");
    return trimmedFrac ? `${whole}.${trimmedFrac}` : whole.toString();
  } catch {
    return "0";
  }
}
