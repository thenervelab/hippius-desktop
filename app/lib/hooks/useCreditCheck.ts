import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import {
  insufficientCreditsDialogOpenAtom,
  InsufficientCreditsReason,
} from "@/app/components/page-sections/drive/atoms/query-atoms";

/**
 * Result shape returned by the Rust `check_action_eligibility` IPC.
 * Mirrors `crate::billing::eligibility::ActionEligibility`.
 */
interface ActionEligibility {
  eligible: boolean;
  reason: string | null;
  currentBalance: number;
  requiredBalance: number;
}

/**
 * Async credit-check hook backed by the Rust `check_action_eligibility`
 * command. Replaces the legacy synchronous `hasSufficientCredits` helper
 * that read from a `staleTime: Infinity` TanStack Query cache.
 *
 * Why this changed:
 *
 * - The old hook compared a cached `useUserCredits` value against `0n`
 *   in the click handler. Since the cache never expired, the gate was
 *   wrong in both directions: it blocked users who had just topped up
 *   (cache says 0, server says 100) AND let through users who had just
 *   spent down (cache says 100, server says 0).
 * - Threshold logic (`creditsNumber < 10` for VM creation) was hardcoded
 *   in JSX components. Adding a new gated action meant changing N
 *   components instead of one Rust constant.
 * - The gate was at the click handler only; nothing prevented bypassing
 *   it by calling the IPC directly. Rust now also enforces inside the
 *   action commands themselves (`require_eligible(...)?` as the first
 *   line of `add_file`, `add_files`, `add_folder`, `add_local_sync_folder`,
 *   and `create_vm`), so the gate is impossible to bypass.
 *
 * Usage from a click handler:
 *
 * ```ts
 * const { checkEligibility } = useCreditCheck();
 *
 * async function onClick() {
 *   if (!(await checkEligibility("file-upload"))) return;
 *   // ... open the upload modal ...
 * }
 * ```
 *
 * The legacy synchronous `hasSufficientCredits` API has been removed —
 * all 6 call sites have been migrated to the async `checkEligibility`
 * shape. The async-ness adds one HTTP round-trip on click, which is the
 * whole point: the gate is now decided against fresh server state
 * instead of a possibly-stale TanStack Query cache.
 */
export function useCreditCheck() {
  const { polkadotAddress } = useWalletAuth();
  const setReason = useSetAtom(insufficientCreditsDialogOpenAtom);

  const checkEligibility = useCallback(
    async (action: InsufficientCreditsReason): Promise<boolean> => {
      if (!polkadotAddress) {
        setReason(action);
        return false;
      }
      try {
        const result = await invoke<ActionEligibility>("check_action_eligibility", {
          accountId: polkadotAddress,
          action,
        });
        if (!result.eligible) {
          setReason(action);
          return false;
        }
        return true;
      } catch (err) {
        // A failed IPC is NOT the same as "not eligible". Conflating
        // them previously showed the Insufficient Credits dialog on any
        // network blip or hung request (users with ample credits were
        // getting the credits-dialog after the app froze on an untimed
        // reqwest call). Surface a generic error toast instead and let
        // the action IPC's own `require_eligible` gate enforce the real
        // answer if/when the user retries.
        console.warn("[useCreditCheck] check_action_eligibility failed:", err);
        toast.error("Couldn't verify your credit balance. Check your connection and try again.");
        return false;
      }
    },
    [polkadotAddress, setReason]
  );

  return { checkEligibility };
}
