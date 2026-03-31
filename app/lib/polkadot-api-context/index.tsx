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

    // Start the Rust block subscription
    invoke("start_block_subscription").catch((err) => {
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
