import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";

import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";

/**
 * How many times the Drive has been unlocked on this computer since the
 * caller mounted: a read keyed on it runs again once the Drive unlocks, so
 * what needed the account's key (the allow lists, an NDA text, names of
 * links per person) shows without reopening anything.
 */
export function useUnlockCount(): number {
  const locked = useAtomValue(syncRequiresReauthAtom);
  const was = useRef(locked);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (was.current && !locked) setCount((n) => n + 1);
    was.current = locked;
  }, [locked]);
  return count;
}
