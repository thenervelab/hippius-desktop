"use client";

import { useEffect, useCallback, useRef, ReactNode } from "react";
import { ApiPromise, WsProvider } from "@polkadot/api";
import {
  WSS_ENDPOINT,
  RECONNECT_INTERVAL,
  MAX_RETRIES,
} from "@/config/constants";
import { useAtomValue, useSetAtom } from "jotai";
import { polkadotApiAtom } from "../global-atoms/polkadotApiAtom";
import { phaseAtom } from "@/components/splash-screen/atoms";

export const usePolkadotApi = () => {
  return useAtomValue(polkadotApiAtom);
};

export function PolkadotApiProvider({ children }: { children: ReactNode }) {
  const setState = useSetAtom(polkadotApiAtom);
  const appPhase = useAtomValue(phaseAtom);
  const isAppReady = appPhase === "ready";

  const apiRef = useRef<ApiPromise | null>(null);
  const wsProviderRef = useRef<WsProvider | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const connectingRef = useRef(false);
  const retryCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const connectionInitiatedRef = useRef(false);

  const cleanup = useCallback(async () => {
    console.log("Cleaning up Polkadot API connections...");
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }

    if (apiRef.current) {
      try {
        await apiRef.current.disconnect();
      } catch (e) {
        console.log("Error disconnecting API:", e);
      }
      apiRef.current = null;
    }

    if (wsProviderRef.current) {
      try {
        await wsProviderRef.current.disconnect();
      } catch (e) {
        console.log("Error disconnecting WebSocket:", e);
      }
      wsProviderRef.current = null;
    }

    if (mountedRef.current) {
      setState((prev) => ({
        ...prev,
        api: null,
        isConnected: false,
        blockNumber: null,
      }));
    }

    connectingRef.current = false;
  }, [setState]);

  const connect = useCallback(async () => {
    // Don't try to connect if the app isn't ready yet
    if (!isAppReady) {
      console.log("Skipping connection: app not ready yet");
      return;
    }

    if (connectingRef.current) {
      console.log("Skipping connection: already connecting");
      return;
    }

    try {
      console.log("Starting connection process...");
      connectingRef.current = true;
      await cleanup();

      console.log("Creating WebSocket provider:", WSS_ENDPOINT);
      const wsProvider = new WsProvider(WSS_ENDPOINT);
      wsProviderRef.current = wsProvider;

      wsProvider.on("error", async (error) => {
        console.error("WebSocket error:", error);
        if (mountedRef.current) {
          setState((prev) => ({ ...prev, isConnected: false }));
          await cleanup();
          if (retryCountRef.current < MAX_RETRIES) {
            reconnectTimeoutRef.current = setTimeout(() => {
              retryCountRef.current++;
              connect();
            }, RECONNECT_INTERVAL);
          }
        }
      });

      wsProvider.on("connected", () => {
        console.log("WebSocket connected!");
        retryCountRef.current = 0; // Reset retry count on successful connection
      });

      wsProvider.on("disconnected", async () => {
        console.log("WebSocket disconnected!");
        if (mountedRef.current) {
          setState((prev) => ({ ...prev, isConnected: false }));
          await cleanup();
          if (retryCountRef.current < MAX_RETRIES) {
            reconnectTimeoutRef.current = setTimeout(() => {
              retryCountRef.current++;
              connect();
            }, RECONNECT_INTERVAL);
          }
        }
      });

      console.log("Creating API...");
      const api = await ApiPromise.create({
        provider: wsProvider,
        throwOnConnect: true,
      });
      apiRef.current = api;

      await api.isReady;
      console.log("API is ready!");

      // Subscribe to new blocks but only update blockNumber
      const unsubscribe = await api.rpc.chain.subscribeNewHeads((header) => {
        if (mountedRef.current) {
          setState((prev) => ({
            ...prev,
            blockNumber: BigInt(header.number.toString()),
          }));
        }
      });

      unsubscribeRef.current = unsubscribe;
      connectingRef.current = false;
      retryCountRef.current = 0; // Reset retry count on successful connection

      if (mountedRef.current) {
        setState((prev) => ({
          ...prev,
          api,
          isConnected: true,
        }));
      }
    } catch (error) {
      console.error("Connection error:", error);
      if (mountedRef.current) {
        setState((prev) => ({ ...prev, isConnected: false }));
        await cleanup();
        if (retryCountRef.current < MAX_RETRIES) {
          reconnectTimeoutRef.current = setTimeout(() => {
            retryCountRef.current++;
            connect();
          }, RECONNECT_INTERVAL);
        }
      }
    }
  }, [cleanup, setState, isAppReady]);

  useEffect(() => {
    mountedRef.current = true;

    // Only try to connect if the app is ready
    if (isAppReady && !connectionInitiatedRef.current) {
      connectionInitiatedRef.current = true;

      connect();
    }

    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [connect, cleanup, isAppReady]);

  return children;
}
