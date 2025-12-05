"use client";

import { useEffect, useCallback, useRef, ReactNode, useState } from "react";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { RECONNECT_INTERVAL } from "@/config/constants";
import { useAtomValue, useSetAtom } from "jotai";
import { polkadotApiAtom } from "@/lib/global-atoms/polkadotApiAtom";
import { invoke } from "@tauri-apps/api/core";

export const usePolkadotApi = () => {
  return useAtomValue(polkadotApiAtom);
};

export function PolkadotApiProvider({ children }: { children: ReactNode }) {
  const setState = useSetAtom(polkadotApiAtom);
  const [wssEndpoint, setWssEndpoint] = useState<string | null>(null);

  const apiRef = useRef<ApiPromise | null>(null);
  const wsProviderRef = useRef<WsProvider | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Use state instead of refs for connection status to ensure proper reactivity
  const [connectionState, setConnectionState] = useState<{
    connecting: boolean;
    connected: boolean;
    initiated: boolean;
  }>({ connecting: false, connected: false, initiated: false });

  // Fetch endpoint on mount - retry until available
  useEffect(() => {
    let isMounted = true;
    let retryTimeout: NodeJS.Timeout | null = null;
    const ENDPOINT_RETRY_INTERVAL = 100; // 100 milliseconds

    const fetchEndpoint = async () => {
      try {
        console.log("Attempting to fetch WSS endpoint...");
        const endpoint = await invoke<string>("get_wss_endpoint");

        if (isMounted && endpoint) {
          console.log("Fetched WSS endpoint:", endpoint);
          setWssEndpoint(endpoint);
        } else if (isMounted) {
          // Endpoint is empty/null, retry
          console.log(
            "WSS endpoint is empty, retrying in",
            ENDPOINT_RETRY_INTERVAL,
            "ms..."
          );
          retryTimeout = setTimeout(fetchEndpoint, ENDPOINT_RETRY_INTERVAL);
        }
      } catch (error) {
        console.error("Failed to fetch WSS endpoint:", error);
        // Retry on error
        if (isMounted) {
          console.log(
            "Retrying endpoint fetch in",
            ENDPOINT_RETRY_INTERVAL,
            "ms..."
          );
          retryTimeout = setTimeout(fetchEndpoint, ENDPOINT_RETRY_INTERVAL);
        }
      }
    };

    fetchEndpoint();

    return () => {
      isMounted = false;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
    };
  }, []);

  const connect = useCallback(
    async (endpoint: string) => {
      console.log("Connect called with endpoint:", endpoint);
      console.log("Current connection state:", connectionState);

      // Don't try to connect if already connected
      if (connectionState.connected) {
        console.log("Skipping connection: already connected");
        return;
      }

      // Don't try to connect if already connecting
      if (connectionState.connecting) {
        console.log("Skipping connection: already connecting");
        return;
      }

      // Clear any pending reconnect
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      console.log("Starting connection process...");
      setConnectionState((prev) => ({
        ...prev,
        connecting: true,
        initiated: true,
      }));

      // Set isConnecting state immediately
      setState((prev) => ({ ...prev, isConnecting: true }));

      // Clean up existing connections
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

      try {
        console.log("Creating WebSocket provider:", endpoint);
        const wsProvider = new WsProvider(endpoint);
        wsProviderRef.current = wsProvider;

        // Create a promise that resolves when connected or rejects on error
        const connectionPromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Connection timeout"));
          }, 30000); // 30 second timeout

          wsProvider.on("error", (error) => {
            console.error("WebSocket error:", error);
          });

          wsProvider.on("connected", () => {
            console.log("WebSocket connected!");
            clearTimeout(timeout);
            resolve();
          });

          wsProvider.on("disconnected", () => {
            console.log("WebSocket disconnected!");
            clearTimeout(timeout);

            setConnectionState((prev) => ({
              ...prev,
              connecting: false,
              connected: false,
            }));
            setState((prev) => ({
              ...prev,
              isConnected: false,
              isConnecting: true,
            }));

            // Schedule reconnect
            console.log(`Scheduling reconnect in ${RECONNECT_INTERVAL}ms...`);
            reconnectTimeoutRef.current = setTimeout(() => {
              // Reset connecting state to allow new connection attempt
              setConnectionState((prev) => ({ ...prev, connecting: false }));
              connect(endpoint);
            }, RECONNECT_INTERVAL);
          });
        });

        // Wait for WebSocket to connect
        await connectionPromise;

        console.log("Creating API...");
        const api = await ApiPromise.create({
          provider: wsProvider,
          throwOnConnect: true,
        });
        apiRef.current = api;

        await api.isReady;
        console.log("API is ready!");

        // Subscribe to new blocks
        const unsubscribe = await api.rpc.chain.subscribeNewHeads((header) => {
          setState((prev) => ({
            ...prev,
            blockNumber: BigInt(header.number.toString()),
          }));
        });

        unsubscribeRef.current = unsubscribe;
        setConnectionState((prev) => ({
          ...prev,
          connecting: false,
          connected: true,
        }));

        setState((prev) => ({
          ...prev,
          api,
          isConnected: true,
          isConnecting: false,
        }));

        console.log("Connection established successfully!");
      } catch (error) {
        console.error("Connection error:", error);
        setConnectionState((prev) => ({
          ...prev,
          connecting: false,
          connected: false,
        }));

        setState((prev) => ({
          ...prev,
          isConnected: false,
          isConnecting: true,
        }));

        // Schedule reconnect on error
        console.log(`Scheduling reconnect in ${RECONNECT_INTERVAL}ms...`);
        reconnectTimeoutRef.current = setTimeout(() => {
          setConnectionState((prev) => ({ ...prev, connecting: false }));
          connect(endpoint);
        }, RECONNECT_INTERVAL);
      }
    },
    [setState, connectionState.connected, connectionState.connecting]
  );

  // Connect when endpoint is available
  useEffect(() => {
    console.log(
      "Effect triggered - wssEndpoint:",
      wssEndpoint,
      "initiated:",
      connectionState.initiated
    );

    if (wssEndpoint && !connectionState.initiated) {
      console.log("Initiating first connection...");
      connect(wssEndpoint);
    }

    return () => {
      // Only cleanup on actual unmount, not on re-renders
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [wssEndpoint, connectionState.initiated, connect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log("PolkadotApiProvider unmounting, cleaning up...");

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }

      if (apiRef.current) {
        apiRef.current.disconnect().catch(console.error);
        apiRef.current = null;
      }

      if (wsProviderRef.current) {
        wsProviderRef.current.disconnect().catch(console.error);
        wsProviderRef.current = null;
      }
    };
  }, []);

  return children;
}
