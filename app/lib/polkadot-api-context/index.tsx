"use client";

import { useEffect, useRef, ReactNode } from "react";
import { useSetAtom } from "jotai";
import { polkadotApiAtom } from "@/lib/global-atoms/polkadotApiAtom";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";

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

    setState((prev) => ({ ...prev, isConnecting: true }));

    // Start the Rust block subscription; `isConnecting` clears once the IPC
    // returns, whether or not it succeeded.
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

    // No `block_number_updated` listener here. Nothing in this window reads
    // the block number, and on Windows every distinct event a webview
    // receives leaves its script in WebView2 for good: a block every ~6 s,
    // for as long as the app runs. The tray popover, which does show it,
    // listens only while it is open (`useTrayPanelData`).

    return () => {
      destroyed = true;
    };
  }, [setState]);

  return children;
}
