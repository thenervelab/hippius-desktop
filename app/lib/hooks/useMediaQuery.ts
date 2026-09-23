"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * `window.matchMedia(query).matches`, kept current.
 *
 * Unlike `useBreakpoint`, the value is right on the first client render
 * (no "xs" frame before the effect runs), which matters when the two
 * branches mount very different things, such as a modal sheet versus a
 * static column. On the server it is `serverFallback`.
 */
export function useMediaQuery(query: string, serverFallback = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return serverFallback;
    return window.matchMedia(query).matches;
  }, [query, serverFallback]);
  const getServerSnapshot = useCallback(() => serverFallback, [serverFallback]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Tailwind's `lg` breakpoint, where the chat shows its side columns inline. */
export const LG_MEDIA_QUERY = "(min-width: 1024px)";
