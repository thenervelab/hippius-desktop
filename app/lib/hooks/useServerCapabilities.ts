// Fetch server capabilities once per session and stash them in
// `serverCapabilitiesAtom` so every UI surface that wants to gate on
// `shares: true` reads the same value.
//
// Mounted in the always-on event-listener layer (next to
// `SyncEventLogger`) so it runs as soon as the user has an account
// id, without coupling to any specific page.

import { useEffect } from "react";
import { useSetAtom } from "jotai";

import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { getServerCapabilities } from "@/app/lib/tauri/shares";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";

export function useServerCapabilities(): void {
  const { polkadotAddress } = useWalletAuth();
  const setCapabilities = useSetAtom(serverCapabilitiesAtom);

  useEffect(() => {
    if (!polkadotAddress) {
      // On logout, clear so the next login refetches and a UI surface
      // never shows share options against the wrong account.
      setCapabilities(null);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const caps = await getServerCapabilities(polkadotAddress);
        if (!cancelled) setCapabilities(caps);
      } catch (err) {
        // Treat a failed capability call the same as a 404: feature
        // unavailable. The Rust layer already collapses 404 to
        // `{ shares: false }`, so this only fires for transport
        // errors — and "hide the feature" is the safe default.
        console.warn("[useServerCapabilities] capability fetch failed:", err);
        if (!cancelled) setCapabilities({ shares: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [polkadotAddress, setCapabilities]);
}
