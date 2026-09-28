"use client";

// Run the app's unlock, then carry on with what needed it.
//
// Sending an emailed invite seals the drive key to the recipient right
// after the mint, so Rust refuses the send from a locked session before
// anything goes out (`NoEncryptionKey`). This opens the same unlock the
// Manage access panel's locked links use (`useUnlockFlow`) and, once its
// dialog closes, runs `resume` once. Rust decides whether the unlock took:
// a cancelled unlock leaves the session locked, so the resumed send is
// refused again and nothing is sent.

import { useCallback, useEffect, useRef } from "react";
import { useAtomValue, useStore } from "jotai";
import { activeRecoveryCheckAtom } from "@/app/lib/global-atoms/recoveryAtoms";
import { useUnlockFlow } from "@/app/lib/hooks/useUnlockFlow";

export function useUnlockThenResume(): (resume: () => void) => void {
  const { unlock } = useUnlockFlow();
  const store = useStore();
  const recoveryCheck = useAtomValue(activeRecoveryCheckAtom);
  const pending = useRef<(() => void) | null>(null);
  const dialogWasOpen = useRef(false);

  useEffect(() => {
    if (recoveryCheck) {
      dialogWasOpen.current = true;
      return;
    }
    if (!dialogWasOpen.current) return;
    dialogWasOpen.current = false;
    const resume = pending.current;
    pending.current = null;
    resume?.();
  }, [recoveryCheck]);

  return useCallback(
    (resume: () => void) => {
      pending.current = resume;
      void unlock().then(() => {
        // No dialog came up: the seed-phrase sign-in took over the window,
        // or there was nothing to unlock. Nothing will close to resume from,
        // so the next Send starts over.
        if (!store.get(activeRecoveryCheckAtom)) pending.current = null;
      });
    },
    [unlock, store],
  );
}
