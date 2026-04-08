import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { insufficientCreditsDialogOpenAtom, InsufficientCreditsReason } from "@/app/components/page-sections/files/atoms/query-atoms";

/**
 * Returns a function that checks whether the user has sufficient credits.
 * If credits are zero or unavailable, opens the InsufficientCreditsDialog
 * with the given reason and returns `false`. Otherwise returns `true`.
 */
export function useCreditCheck() {
  const { data: credits } = useUserCredits();
  const setInsufficientOpen = useSetAtom(insufficientCreditsDialogOpenAtom);

  const hasSufficientCredits = useCallback(
    (reason: InsufficientCreditsReason = "file-upload"): boolean => {
      if (credits === undefined || credits <= BigInt(0)) {
        setInsufficientOpen(reason);
        return false;
      }
      return true;
    },
    [credits, setInsufficientOpen]
  );

  return { hasSufficientCredits };
}
