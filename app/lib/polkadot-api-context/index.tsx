"use client";

import { useEffect, useCallback, useRef, ReactNode, useState } from "react";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { useAtomValue, useSetAtom } from "jotai";
import { polkadotApiAtom } from "@/lib/global-atoms/polkadotApiAtom";
import { invoke } from "@tauri-apps/api/core";

// Global manual reconnect hook
let manualReconnectFn: (() => void) | null = null;

export const usePolkadotApi = () => {
  return useAtomValue(polkadotApiAtom);
};

/**
 * Manually trigger a reconnection attempt to the blockchain.
 */
export const usePolkadotReconnect = () => {
  return useCallback(async () => {
    if (manualReconnectFn) {
      manualReconnectFn();
    } else {
      console.warn("Reconnect not available yet");
    }
  }, []);
};

export function PolkadotApiProvider({ children }: { children: ReactNode }) {
  const setState = useSetAtom(polkadotApiAtom);
  const [wssEndpoint, setWssEndpoint] = useState<string | null>(null);
  const initiatedRef = useRef(false);

  const apiRef = useRef<ApiPromise | null>(null);
  const providerRef = useRef<WsProvider | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const disconnectTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ── Fetch WSS endpoint from Rust (retries until available) ──
  useEffect(() => {
    let alive = true;
    let timer: NodeJS.Timeout | null = null;

    const fetch = async () => {
      try {
        const ep = await invoke<string>("get_wss_endpoint");
        if (alive && ep) {
          setWssEndpoint(ep);
          return;
        }
      } catch {
        /* ignore */
      }
      if (alive) timer = setTimeout(fetch, 100);
    };
    fetch();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // ── Main connection effect — runs once when endpoint is available ──
  useEffect(() => {
    if (!wssEndpoint || initiatedRef.current) return;
    initiatedRef.current = true;

    let destroyed = false;

    // Mark connecting
    setState((prev) => ({ ...prev, isConnecting: true }));

    /*
     * WsProvider has BUILT-IN auto-reconnect (default autoConnectMs = 2500).
     * We create ONE provider, ONE ApiPromise, and just listen to events.
     * We never destroy/recreate on transient disconnects — that was the bug.
     */
    const provider = new WsProvider(wssEndpoint, 2500); // auto-reconnect every 2.5s
    providerRef.current = provider;

    provider.on("connected", () => {
      if (destroyed) return;
      console.log("✅ WS connected");

      // Cancel any pending "mark disconnected" timer — we reconnected in time
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
        console.log("   Cancelled disconnect grace timer (reconnected in time)");
      }

      setState((prev) => ({
        ...prev,
        isConnected: true,
        isConnecting: false,
      }));
    });

    provider.on("disconnected", () => {
      if (destroyed) return;
      console.log("🔌 WS disconnected (auto-reconnect will handle it)");

      // Start a grace period — only mark disconnected if we haven't reconnected
      // within 10 seconds. This prevents the block number from flickering on
      // brief network blips while still hiding it on sustained outages.
      if (!disconnectTimerRef.current) {
        disconnectTimerRef.current = setTimeout(() => {
          disconnectTimerRef.current = null;
          if (destroyed) return;
          console.log("⏱ Grace period expired — marking disconnected");
          setState((prev) => ({
            ...prev,
            isConnected: false,
            isConnecting: false,
          }));
        }, 10_000);
      }
    });

    provider.on("error", (err: unknown) => {
      if (destroyed) return;
      console.warn("⚠ WS error (auto-reconnect will retry):", err);
    });

    // Create ApiPromise (it waits for the provider to be ready internally)
    ApiPromise.create({ provider, noInitWarn: true })
      .then(async (api) => {
        if (destroyed) {
          api.disconnect().catch(() => { });
          return;
        }
        apiRef.current = api;

        setState((prev) => ({
          ...prev,
          api,
          isConnected: true,
          isConnecting: false,
        }));

        console.log("📦 API ready, subscribing to new heads…");

        try {
          const unsub = await api.rpc.chain.subscribeNewHeads((header) => {
            if (destroyed) return;
            setState((prev) => ({
              ...prev,
              blockNumber: BigInt(header.number.toString()),
              // Every new block proves we're connected
              isConnected: true,
            }));
          });
          unsubRef.current = unsub;
          console.log("✅ Block subscription active");
        } catch (err) {
          console.warn("⚠ Block subscription failed:", err);
        }
      })
      .catch((err) => {
        if (destroyed) return;
        console.error("❌ ApiPromise.create failed:", err);
        setState((prev) => ({
          ...prev,
          isConnected: false,
          isConnecting: false,
        }));
      });

    // Manual reconnect: just disconnect the provider so its auto-reconnect
    // kicks in immediately (avoids full teardown).
    manualReconnectFn = () => {
      console.log("🔄 Manual reconnect requested");
      try {
        provider.disconnect().catch(() => { });
        // WsProvider will auto-reconnect after autoConnectMs
      } catch {
        /* ignore */
      }
    };

    // Cleanup only on true unmount
    return () => {
      destroyed = true;
      manualReconnectFn = null;

      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }

      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      if (apiRef.current) {
        apiRef.current.disconnect().catch(() => { });
        apiRef.current = null;
      }
      if (providerRef.current) {
        providerRef.current.disconnect().catch(() => { });
        providerRef.current = null;
      }
    };
  }, [wssEndpoint, setState]);

  return children;
}
