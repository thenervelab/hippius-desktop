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

export const usePolkadotApi = () => {
  return useAtomValue(polkadotApiAtom);
};

export function PolkadotApiProvider({ children }: { children: ReactNode }) {
  const setState = useSetAtom(polkadotApiAtom);

  const apiRef = useRef<ApiPromise | null>(null);
  const wsProviderRef = useRef<WsProvider | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const connectingRef = useRef(false);
  const retryCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
      await apiRef.current.disconnect();
      apiRef.current = null;
    }

    if (wsProviderRef.current) {
      await wsProviderRef.current.disconnect();
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
  }, [cleanup, setState]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [connect, cleanup]);

  return children;
}
