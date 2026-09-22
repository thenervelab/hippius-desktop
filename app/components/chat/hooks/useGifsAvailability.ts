"use client";

import { useCallback } from "react";
import { useAtomValue, useStore } from "jotai";

import {
  type GifsAvailability,
  gifsAvailabilityAtom,
  gifsProbeAtom,
} from "@/components/chat/chat-ui-atoms";
import { probeGifsAvailability } from "@/lib/chat/gifs-api";

/**
 * Is the GIF proxy enabled on this deployment? The answer is settled once
 * per session: `ensure()` runs one `featured?limit=1` probe the first time
 * it is asked (the composer calls it when the GIF button is hovered or
 * focused, and before the `/gif` command opens the picker), concurrent
 * callers share the in-flight request, and a settled `ready` / `disabled`
 * is never re-probed. A probe that fails for another reason (network, 429,
 * expired session) leaves the question open: the button stays enabled and
 * the picker reports the error inline with a Retry instead.
 *
 * The composer never opens the picker while `disabled`; it renders the
 * button greyed out with an explanation. That is what stops the popover
 * from flashing open and vanishing on a deployment without a key.
 *
 * Rust holds the API token, so unlike the console there is no "signed out"
 * short-circuit here: an unauthenticated invoke simply rejects and leaves
 * the question open.
 */
export function useGifsAvailability(): {
  availability: GifsAvailability;
  ensure: () => Promise<GifsAvailability>;
} {
  const store = useStore();
  const availability = useAtomValue(gifsAvailabilityAtom);

  const ensure = useCallback((): Promise<GifsAvailability> => {
    const settled = store.get(gifsAvailabilityAtom);
    if (settled !== "unknown") return Promise.resolve(settled);
    const pending = store.get(gifsProbeAtom);
    if (pending) return pending;
    const probe: Promise<GifsAvailability> = probeGifsAvailability()
      .then((ok): GifsAvailability => {
        // A page loaded inside the picker may have settled it meanwhile.
        const current = store.get(gifsAvailabilityAtom);
        if (current !== "unknown") return current;
        const next: GifsAvailability = ok ? "ready" : "disabled";
        store.set(gifsAvailabilityAtom, next);
        return next;
      })
      .catch((): GifsAvailability => store.get(gifsAvailabilityAtom))
      .finally(() => {
        if (store.get(gifsProbeAtom) === probe) store.set(gifsProbeAtom, null);
      });
    store.set(gifsProbeAtom, probe);
    return probe;
  }, [store]);

  return { availability, ensure };
}
