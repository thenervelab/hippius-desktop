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
import { useStore } from "jotai";
import { activeRecoveryCheckAtom } from "@/app/lib/global-atoms/recoveryAtoms";
import { useUnlockFlow } from "@/app/lib/hooks/useUnlockFlow";

export function useUnlockThenResume(): (resume: () => void) => void {
  const { unlock } = useUnlockFlow();
  const store = useStore();
  const pending = useRef<(() => void) | null>(null);
  const stopWatching = useRef<(() => void) | null>(null);

  // Stop watching when the section goes away, so a later close resumes nothing.
  useEffect(
    () => () => {
      stopWatching.current?.();
      stopWatching.current = null;
      pending.current = null;
    },
    [],
  );

  return useCallback(
    (resume: () => void) => {
      pending.current = resume;
      void unlock().then(() => {
        // No dialog came up: the seed-phrase sign-in took over the window,
        // or there was nothing to unlock. Nothing will close to resume from,
        // so the next Send starts over.
        if (!store.get(activeRecoveryCheckAtom)) {
          pending.current = null;
          return;
        }
        // Watch the dialog in the store itself, not through a render: an
        // open and close that land before the next render would otherwise
        // never be seen, and the send would be lost.
        stopWatching.current?.();
        const stop = store.sub(activeRecoveryCheckAtom, () => {
          if (store.get(activeRecoveryCheckAtom)) return;
          stop();
          if (stopWatching.current === stop) stopWatching.current = null;
          const next = pending.current;
          pending.current = null;
          next?.();
        });
        stopWatching.current = stop;
      });
    },
    [unlock, store],
  );
}
