import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import {
  insufficientCreditsDialogOpenAtom,
  InsufficientCreditsReason,
} from "@/app/components/page-sections/drive/atoms/query-atoms";
import {
  getUploadBlockReason,
  isUploadBlocked,
} from "@/app/components/page-sections/drive/uploadRoomState";

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
 * command. Drive upload clicks also consult `get_storage_overview` first:
 * an access-key account with no plan (`source: "none"`) must open the
 * subscribe dialog without relying on `/can_upload`, which fail-opens and
 * is polled with `bytes: 0`.
 */
export function useCreditCheck() {
  const { polkadotAddress } = useWalletAuth();
  const setReason = useSetAtom(insufficientCreditsDialogOpenAtom);
  const { data: overview } = useStorageOverview();
  const overviewBlock = getUploadBlockReason(overview);
  const uploadBlocked = isUploadBlocked(overview, false);

  const checkEligibility = useCallback(
    async (action: InsufficientCreditsReason): Promise<boolean> => {
      // Overview already knows this account cannot store anything — do not
      // wait on a fail-open pre-flight that would open the picker.
      if (getUploadBlockReason(overview) !== null) {
        setReason(action);
        return false;
      }
      if (!polkadotAddress) {
        setReason(action);
        return false;
      }
      try {
        const result = await invoke<ActionEligibility>(
          "check_action_eligibility",
          {
            accountId: polkadotAddress,
            action,
          },
        );
        if (!result.eligible) {
          setReason(action);
          return false;
        }
        return true;
      } catch (err) {
        // A failed IPC is NOT the same as "not eligible". Conflating
        // them previously showed the Insufficient Credits dialog on any
        // network blip or hung request. Surface a generic error toast
        // instead and let the action IPC's own `require_eligible` gate
        // enforce the real answer if/when the user retries.
        console.warn("[useCreditCheck] check_action_eligibility failed:", err);
        toast.error(
          "Couldn't verify your credit balance. Check your connection and try again.",
        );
        return false;
      }
    },
    [polkadotAddress, setReason, overview],
  );

  /**
   * Upload / sync click sites: open subscribe/upgrade immediately when
   * Overview (or a polled eligibility refusal) already says there is no
   * room — no picker, no encrypt-then-fail. Backend `require_eligible`
   * remains the gate on the write itself.
   */
  const requireUploadRoom = useCallback(
    async (
      action: InsufficientCreditsReason,
      knownStorageFull = false,
    ): Promise<boolean> => {
      if (knownStorageFull || getUploadBlockReason(overview) !== null) {
        setReason(action);
        return false;
      }
      return checkEligibility(action);
    },
    [checkEligibility, setReason, overview],
  );

  return {
    checkEligibility,
    requireUploadRoom,
    /** Dim styling / empty-state from Overview (no plan or full). */
    uploadBlocked,
    /** Subscribe vs upgrade copy for the blocking dialog. */
    uploadBlockReason: overviewBlock,
  };
}
