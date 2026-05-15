"use client";

import { useEffect, useRef, ReactNode } from "react";
import { useSetAtom } from "jotai";
import { polkadotApiAtom } from "@/lib/global-atoms/polkadotApiAtom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAtomValue } from "jotai";

interface BlockUpdate {
  blockNumber: number;
  isConnected: boolean;
}

export const usePolkadotApi = () => {
  return useAtomValue(polkadotApiAtom);
};

export function PolkadotApiProvider({ children }: { children: ReactNode }) {
  const setState = useSetAtom(polkadotApiAtom);
  const initiatedRef = useRef(false);

  useEffect(() => {
    if (initiatedRef.current) return;
    initiatedRef.current = true;

    let destroyed = false;
    let unlisten: (() => void) | null = null;

    setState((prev) => ({ ...prev, isConnecting: true }));

    // Start the Rust block subscription. `isConnecting` is also
    // cleared by:
    //
    // - the `.catch` below, if the IPC itself failed
    // - the `block_number_updated` listener, if at least one finalized
    //   block has arrived from the subscription
    //
    // Neither of those clears triggers when the IPC succeeds (so no
    // catch) but the subscription stays silent (no blocks for a long
    // window, e.g. the WS connected but the chain hasn't produced a
    // new finalized block yet). The UI would then sit on "Connecting"
    // indefinitely. Clearing `isConnecting` on successful IPC return
    // collapses the steady "connected, no block yet" state into the
    // post-connect view; `isConnected` correctly stays false until
    // the listener flips it.
    invoke("start_block_subscription")
      .then(() => {
        if (!destroyed) {
          setState((prev) => ({ ...prev, isConnecting: false }));
        }
      })
      .catch((err) => {
        console.warn("[PolkadotApi] Failed to start block subscription:", err);
        if (!destroyed) {
          setState((prev) => ({ ...prev, isConnecting: false }));
        }
      });

    // Listen for block updates from Rust
    listen<BlockUpdate>("block_number_updated", (e) => {
      if (destroyed) return;
      setState({
        blockNumber: BigInt(e.payload.blockNumber),
        isConnected: e.payload.isConnected,
        isConnecting: false,
      });
    }).then((u) => {
      if (destroyed) {
        u();
      } else {
        unlisten = u;
      }
    });

    return () => {
      destroyed = true;
      unlisten?.();
    };
  }, [setState]);

  return children;
}
