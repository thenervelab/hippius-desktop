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
  /**
   * The write lands in a drive shared with this account, whose owner pays.
   * The answer is then about the drive alone; this account's own plan
   * (Overview) says nothing about it.
   */
  ownerPays?: boolean;
  /** Rust's sentence for a shared drive's refusal, shown as is. */
  message?: string | null;
}

/** Shown when Rust refused a shared drive's upload without a sentence. */
const SHARED_DRIVE_REFUSED = "This shared drive can't take uploads right now.";

/**
 * Async credit-check hook backed by the Rust `check_action_eligibility`
 * command. Drive upload clicks also consult `get_storage_overview` first:
 * an access-key account with no plan (`source: "none"`) must open the
 * subscribe dialog without relying on `/can_upload`, which fail-opens and
 * is polled with `bytes: 0`.
 *
 * A click that names the drive it writes into (`driveLabel`) asks Rust
 * first. When Rust says the drive is shared with this account (`ownerPays`)
 * the owner pays for it, so this account's own Overview is not consulted:
 * a member with no plan of their own may still upload, and a refusal is
 * Rust's sentence about the drive, never the plan dialog.
 */
export function useCreditCheck() {
  const { polkadotAddress } = useWalletAuth();
  const setReason = useSetAtom(insufficientCreditsDialogOpenAtom);
  const { data: overview } = useStorageOverview();
  const overviewBlock = getUploadBlockReason(overview);
  const uploadBlocked = isUploadBlocked(overview, false);

  const checkEligibility = useCallback(
    async (
      action: InsufficientCreditsReason,
      driveLabel?: string | null,
      knownStorageFull = false,
    ): Promise<boolean> => {
      // This account's own plan already says it cannot store anything.
      const ownBlocked =
        knownStorageFull || getUploadBlockReason(overview) !== null;
      // Overview already knows this account cannot store anything, and the
      // write names no drive that somebody else pays for: do not wait on a
      // fail-open pre-flight that would open the picker.
      if (ownBlocked && !driveLabel) {
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
            ...(driveLabel ? { driveLabel } : {}),
          },
        );
        if (result.ownerPays) {
          if (result.eligible) return true;
          toast.error(result.message || SHARED_DRIVE_REFUSED);
          return false;
        }
        if (ownBlocked || !result.eligible) {
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
   * room, no picker, no encrypt-then-fail. Backend `require_eligible`
   * remains the gate on the write itself.
   *
   * `driveLabel` is the drive the upload lands in, when the surface knows
   * it. A drive shared with this account is judged on its owner's room,
   * whatever this account's own plan says (see the hook's doc).
   */
  const requireUploadRoom = useCallback(
    async (
      action: InsufficientCreditsReason,
      knownStorageFull = false,
      driveLabel?: string | null,
    ): Promise<boolean> =>
      checkEligibility(action, driveLabel, knownStorageFull),
    [checkEligibility],
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
