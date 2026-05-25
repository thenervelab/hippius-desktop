"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useWalletAuth } from "@/app/lib/wallet-auth-context";

/** Wire-format constants that mirror Rust's `bridge::commands` event
 *  names. Keep both sides in lock-step — drift here silently loses
 *  progress updates. */
const BRIDGE_STEP_EVENT = "hippius_bridge_step";
const BRIDGE_TX_UPDATED_EVENT = "hippius_bridge_tx_updated";

export type BridgeDirection = "alpha-to-halpha" | "halpha-to-alpha";

export type BridgeStatus =
  | "pending"
  | "confirmed"
  | "processing"
  | "completed"
  | "failed"
  | "unknown";

export type BridgeStepState = "pending" | "active" | "done" | "error";

export interface BridgeStep {
  step: number;
  label: string;
  detail: string;
  state: BridgeStepState;
}

export interface BridgeTransactionEvent {
  type: string;
  timestamp: number;
  message: string;
  data?: unknown;
}

export interface TrackedBridgeTransaction {
  id: string;
  direction: BridgeDirection;
  status: BridgeStatus;
  /** Amount in smallest unit, as a string (BigInt-safe). */
  amount: string;
  /** Decimals for `amount` — 9 for Alpha, 18 for hAlpha. */
  amountDecimals: number;
  senderAddress: string;
  recipientAddress: string;
  sourceTxHash?: string;
  destinationTxHash?: string;
  depositId?: string;
  withdrawalId?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  attestations: number;
  requiredAttestations: number;
  events: BridgeTransactionEvent[];
  denialReason?: string;
  refunded: boolean;
}

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
  /** Basis-points (e.g. 10 = 0.10%). Divide by `feeDenominator`. */
  feeNumerator: number;
  feeDenominator: number;
  /** Smallest-unit minimums, as strings (BigInt-safe). */
  minAlphaPlanck: string;
  minHalphaPlanck: string;
  minBufferBps: number;
}

export interface BridgeSubmitResult {
  bridgeTransactionId: string;
  txHash: string;
}

/** Cached query keys so external invalidation matches the hook's. */
export const BRIDGE_TRANSACTIONS_QUERY_KEY = ["bridge", "transactions"] as const;
export const BRIDGE_CONFIG_QUERY_KEY = ["bridge", "config"] as const;

/**
 * Top-level bridge hook used by the dialog + history table.
 *
 * - `config`: returns the testnet endpoints, fees and minimums fetched
 *   from Rust on mount (stable after first load).
 * - `transactions`: returns every tracked bridge tx for the auth user,
 *   newest first. Live-updates via `hippius_bridge_tx_updated` events
 *   so a successful submit refreshes the history table without a manual
 *   refetch.
 * - `wizardSteps`: latest steps payload pushed by Rust during a submit
 *   so the dialog can render a per-step progress timeline. Cleared by
 *   `clearWizardSteps()` when the dialog closes / the flow is reset.
 * - `submitHalphaToAlpha`: runs the live hAlpha → Alpha flow against
 *   the AlphaBridge pallet. Returns the new `bridgeTransactionId` +
 *   on-chain extrinsic hash so callers can correlate with the tracked
 *   row.
 * - `submitAlphaToHalpha`: stubbed in the desktop build — invokes the
 *   IPC so the structured error from Rust (see commands.rs) reaches the
 *   FE unchanged, letting the dialog render its "not yet wired"
 *   explanation.
 */
export function useBridge() {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  const configQuery = useQuery<BridgeConfig>({
    queryKey: BRIDGE_CONFIG_QUERY_KEY,
    queryFn: () => invoke<BridgeConfig>("bridge_get_config"),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const transactionsQuery = useQuery<TrackedBridgeTransaction[]>({
    // Key on the auth address so logout/login flushes any prior user's
    // history out of the cache before the next query runs.
    queryKey: [...BRIDGE_TRANSACTIONS_QUERY_KEY, polkadotAddress ?? "anon"],
    queryFn: () => invoke<TrackedBridgeTransaction[]>("bridge_get_transactions"),
    enabled: !!polkadotAddress,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  // Wizard step state lives in the hook so the dialog (or any other
  // listener) renders the same payload Rust emitted, without each
  // consumer re-subscribing to events independently. `useRef` for the
  // unsub fns so a quick re-mount can't double-register.
  const [wizardSteps, setWizardSteps] = useState<BridgeStep[]>([]);
  const unlistenStepRef = useRef<UnlistenFn | null>(null);
  const unlistenTxRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    let cancelled = false;

    void listen<BridgeStep[]>(BRIDGE_STEP_EVENT, (event) => {
      if (cancelled) return;
      setWizardSteps(event.payload ?? []);
    }).then((unsub) => {
      if (cancelled) {
        unsub();
        return;
      }
      unlistenStepRef.current = unsub;
    });

    void listen<TrackedBridgeTransaction>(BRIDGE_TX_UPDATED_EVENT, (event) => {
      if (cancelled) return;
      const incoming = event.payload;
      if (!incoming) return;
      queryClient.setQueryData<TrackedBridgeTransaction[]>(
        [...BRIDGE_TRANSACTIONS_QUERY_KEY, polkadotAddress ?? "anon"],
        (prev) => {
          if (!prev) return [incoming];
          const idx = prev.findIndex((t) => t.id === incoming.id);
          if (idx < 0) return [incoming, ...prev];
          const next = prev.slice();
          next[idx] = incoming;
          return next;
        },
      );
    }).then((unsub) => {
      if (cancelled) {
        unsub();
        return;
      }
      unlistenTxRef.current = unsub;
    });

    return () => {
      cancelled = true;
      unlistenStepRef.current?.();
      unlistenTxRef.current?.();
      unlistenStepRef.current = null;
      unlistenTxRef.current = null;
    };
  }, [polkadotAddress, queryClient]);

  const clearWizardSteps = useCallback(() => setWizardSteps([]), []);

  const submitHalphaToAlpha = useCallback(
    async (params: {
      amount: string;
      recipientAddress: string;
      password: string;
    }): Promise<BridgeSubmitResult> => {
      const result = await invoke<BridgeSubmitResult>(
        "bridge_submit_halpha_to_alpha",
        {
          amount: params.amount,
          recipientAddress: params.recipientAddress,
          password: params.password,
        },
      );
      // Belt-and-braces refetch — the tx-updated event already keeps
      // the cache fresh, but the live refetch covers cases where the
      // listener hadn't subscribed in time (e.g. immediate close).
      void transactionsQuery.refetch();
      return result;
    },
    [transactionsQuery],
  );

  const submitAlphaToHalpha = useCallback(
    async (params: {
      amount: string;
      hotkey?: string;
      password: string;
    }): Promise<BridgeSubmitResult> => {
      return invoke<BridgeSubmitResult>("bridge_submit_alpha_to_halpha", {
        amount: params.amount,
        hotkey: params.hotkey ?? null,
        password: params.password,
      });
    },
    [],
  );

  return useMemo(
    () => ({
      config: configQuery.data,
      configLoading: configQuery.isLoading,
      transactions: transactionsQuery.data ?? [],
      transactionsLoading: transactionsQuery.isLoading,
      transactionsError: transactionsQuery.error,
      refetchTransactions: transactionsQuery.refetch,
      wizardSteps,
      clearWizardSteps,
      submitHalphaToAlpha,
      submitAlphaToHalpha,
    }),
    [
      configQuery.data,
      configQuery.isLoading,
      transactionsQuery.data,
      transactionsQuery.isLoading,
      transactionsQuery.error,
      transactionsQuery.refetch,
      wizardSteps,
      clearWizardSteps,
      submitHalphaToAlpha,
      submitAlphaToHalpha,
    ],
  );
}

/**
 * Format a smallest-unit string as a display number using the supplied
 * `decimals`. Used by every bridge UI surface so balances and history
 * rows render the same regardless of direction.
 *
 * Truncates (never rounds up) to `displayDecimals` so the value never
 * appears to exceed the underlying balance.
 */
export function formatBridgeAmount(
  planck: string | undefined,
  decimals: number,
  displayDecimals = 6,
): string {
  if (!planck) return "0";
  try {
    const value = BigInt(planck);
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
