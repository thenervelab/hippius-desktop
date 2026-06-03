"use client";

import { useCallback } from "react";
import { useAtom } from "jotai";
import { creditsExhaustedAtom } from "@/lib/store/syncAtoms";
import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
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
    <div className="relative overflow-hidden rounded-xl border border-warning-50/40 bg-gradient-to-r from-warning-50/[0.14] to-warning-50/[0.04] px-4 py-3.5 mt-2 dark:border-warning-50/35 dark:from-warning-50/[0.16] dark:to-warning-50/[0.05]">
      <button
        onClick={handleDismiss}
        className="absolute right-3 top-3 text-grey-50 transition-colors hover:text-grey-10 dark:text-grey-dark-700 dark:hover:text-white"
        title="Dismiss — banner reappears on the next 402"
        aria-label="Dismiss credits-exhausted banner"
      >
        <X className="size-4" />
      </button>
      <div className="flex items-center gap-3 pr-8">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning-50">
          <Icons.OctagonAlert className="size-4 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-grey-10 dark:text-white">
            Out of credits
          </p>
          <p className="text-xs text-grey-50 dark:text-grey-dark-700">
            Need ${required}, have ${balance}. {info.fileCount} {fileWord} paused.
          </p>
        </div>
        <Button
          variant="primary"
          size="auto"
          className="h-[30px] gap-[10px] rounded-[6px] px-3 py-[10px] font-geist text-[14px] leading-[1.109] tracking-[-0.28px]"
          onClick={handleTopUp}
        >
          Top up
        </Button>
      </div>
    </div>
  );
}
