"use client";

import { useCallback } from "react";
import { useAtom } from "jotai";
import { creditsExhaustedAtom } from "@/lib/store/syncAtoms";
import { Icons } from "@/components/ui";
import { openLinkByKey } from "@/lib/utils/links";

/**
 * Top-of-page banner shown when the sync engine hits an HTTP 402
 * `InsufficientBalance` failure on one or more files.
 *
 * The banner replaces the generic "Sync Failed" toast (which would
 * mis-attribute the failure to a sync engine bug) with a billing-
 * specific CTA: "Top up". It is intentionally dismissible per cycle —
 * the user might be aware of the situation already (e.g. they kicked
 * off a top-up in the console and don't need a constant reminder).
 *
 * Visibility lifecycle (driven by `useCreditsExhausted` writing to the
 * atom; see that hook for the contract):
 *
 *   - `null`           → banner hidden
 *   - non-null payload → banner shown
 *   - dismiss click    → atom set to `null` (banner hides until the
 *                        next 402 event re-raises it)
 *   - `hcfs_sync_started` for any drive → atom cleared by the hook
 *
 * Design parity with `ConflictsBanner` / `MigrationBanner` —
 * intentionally so: same horizontal toolbar slot, same dismissal
 * affordance, same visual weight.
 */
export default function CreditsExhaustedBanner() {
  const [info, setInfo] = useAtom(creditsExhaustedAtom);

  const handleTopUp = useCallback(() => {
    // Reuse the existing CREDITS console link. The plan deliberately
    // chose not to introduce new top-up logic in-app — the console
    // already owns that flow and a stub navigation would duplicate it.
    void openLinkByKey("CREDITS");
  }, []);

  const handleDismiss = useCallback(() => {
    setInfo(null);
  }, [setInfo]);

  if (!info) return null;

  // Cents → dollars for display. Integer math kept upstream so the
  // banner is the only place we cross the lossy boundary. `toFixed(2)`
  // is the right call here because the source is a Number already and
  // the magnitude is small (single-dollar to low-thousands range);
  // arbitrary-precision is unnecessary for display.
  const balance = (info.balanceCents / 100).toFixed(2);
  const required = (info.requiredCents / 100).toFixed(2);
  const fileWord = info.fileCount === 1 ? "file" : "files";

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2 mt-2 rounded-lg border border-warning-50/30 bg-warning-50/5">
      <div className="flex items-center gap-2 min-w-0">
        <Icons.OctagonAlert className="size-4 text-warning-50 shrink-0" />
        <span className="text-sm text-grey-10">
          Out of credits. Need ${required}, have ${balance}. {info.fileCount}{" "}
          {fileWord} paused.
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={handleTopUp}
          className="px-3 py-1.5 text-xs font-medium rounded bg-primary-50 text-white hover:bg-primary-40 shadow-outer-action-button transition-colors"
        >
          Top up
        </button>
        <button
          onClick={handleDismiss}
          className="p-1 rounded hover:bg-grey-90 transition-colors"
          title="Dismiss — banner reappears on the next 402"
          aria-label="Dismiss credits-exhausted banner"
        >
          <Icons.CloseCircle className="size-4 text-grey-40" />
        </button>
      </div>
    </div>
  );
}
