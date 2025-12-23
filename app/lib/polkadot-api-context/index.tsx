"use client";

import { useEffect, useCallback, useRef, ReactNode, useState } from "react";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { useAtomValue, useSetAtom } from "jotai";
import { polkadotApiAtom } from "@/lib/global-atoms/polkadotApiAtom";
import { invoke } from "@tauri-apps/api/core";

// Store for the current endpoint and reconnect function (for manual refresh)
let globalEndpoint: string | null = null;
let globalReconnect: ((endpoint: string) => Promise<void>) | null = null;
let globalReconnectCount = 0; // Track reconnect attempts for backoff

export const usePolkadotApi = () => {
  return useAtomValue(polkadotApiAtom);
};

/**
 * Manually trigger a reconnection attempt to the blockchain
 * Useful for UI button to refresh connection
 */
export const usePolkadotReconnect = () => {
  return useCallback(async () => {
    if (globalEndpoint && globalReconnect) {
      console.log("Manual reconnect triggered");
      globalReconnectCount = 0; // Reset backoff on manual reconnect
      await globalReconnect(globalEndpoint);
    } else {
      console.warn("Reconnect not available yet");
    }
  }, []);
};

/**
 * Calculate exponential backoff delay with jitter
 * Starts at 100ms, caps at 5000ms, includes random jitter
 */
function getBackoffDelay(attemptCount: number): number {
  const baseDelay = Math.min(100 * Math.pow(2, attemptCount), 5000);
  const jitter = Math.random() * 0.1 * baseDelay; // 10% jitter
  return Math.round(baseDelay + jitter);
}

export function PolkadotApiProvider({ children }: { children: ReactNode }) {
  const setState = useSetAtom(polkadotApiAtom);
  const [wssEndpoint, setWssEndpoint] = useState<string | null>(null);

  const apiRef = useRef<ApiPromise | null>(null);
  const wsProviderRef = useRef<WsProvider | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const fallbackTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  // Setup heartbeat to detect dead connections
  const setupHeartbeat = useCallback(() => {
    // Clear existing heartbeat
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }

    // Check connection health every 2 seconds (aggressive for fast detection)
    heartbeatIntervalRef.current = setInterval(async () => {
      try {
        if (apiRef.current && connectionState.connected) {
          // Use a lightweight health check via RPC call with strict timeout
          // This will fail immediately if the connection is dead
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Heartbeat timeout")), 2000)
          );
          const versionPromise = apiRef.current.rpc.system.version();
          await Promise.race([versionPromise, timeoutPromise]);
          console.log("✓ Heartbeat healthy");
        }
      } catch (error) {
        console.warn("⚠ Heartbeat failed, triggering reconnect:", error);
        setConnectionState((prev) => ({
          ...prev,
          connecting: false,
          connected: false,
        }));
        setState((prev) => ({
          ...prev,
          isConnected: false,
          isConnecting: false,
        }));
        // Force immediate reconnection without waiting
        if (globalReconnect && globalEndpoint) {
          globalReconnect(globalEndpoint).catch(console.error);
        }
      }
    }, 2000); // 2 second interval for fast detection
  }, [connectionState.connected]);

  const connect = useCallback(
    async (endpoint: string) => {
      console.log("🔄 Connect called with endpoint:", endpoint);
      console.log("   Current state:", connectionState);

      // Don't try to connect if already connected
      if (connectionState.connected) {
        console.log("✓ Already connected, skipping");
        return;
      }

      // Don't try to connect if already connecting
      if (connectionState.connecting) {
        console.log("⏳ Already connecting, skipping");
        return;
      }

      // Clear any pending reconnect timers
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (fallbackTimeoutRef.current) {
        clearTimeout(fallbackTimeoutRef.current);
        fallbackTimeoutRef.current = null;
      }

      console.log("🚀 Starting connection process... (attempt #", globalReconnectCount + 1, ")");
      setConnectionState((prev) => ({
        ...prev,
        connecting: true,
        initiated: true,
      }));

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

      let connectionSucceeded = false;

      try {
        console.log("📡 Creating WebSocket provider...");
        const wsProvider = new WsProvider(endpoint);
        wsProviderRef.current = wsProvider;

        // Calculate timeout based on attempt count
        // First attempt: 5 seconds, increases with retries, caps at 15 seconds
        const timeoutMs = Math.min(5000 + globalReconnectCount * 2000, 15000);
        console.log(`   Connection timeout: ${timeoutMs}ms`);

        // Create a promise that resolves when connected or rejects on error
        const connectionPromise = new Promise<void>((resolve, reject) => {
          let timeoutId: NodeJS.Timeout | null = null;
          let resolved = false;

          const handleError = (error: unknown) => {
            console.error("❌ WebSocket error:", error);
            if (timeoutId) clearTimeout(timeoutId);
            if (!resolved) {
              resolved = true;
              reject(error);
            }
          };

          const handleConnected = () => {
            console.log("✅ WebSocket connected!");
            if (timeoutId) clearTimeout(timeoutId);
            if (!resolved) {
              resolved = true;
              resolve();
            }
          };

          const handleDisconnected = () => {
            console.log("🔌 WebSocket disconnected!");
            if (timeoutId) clearTimeout(timeoutId);

            if (!resolved) {
              resolved = true;
              reject(new Error("WebSocket disconnected before ready"));
            }

            setConnectionState((prev) => ({
              ...prev,
              connecting: false,
              connected: false,
            }));
            setState((prev) => ({
              ...prev,
              isConnected: false,
              isConnecting: false,
            }));

            // Schedule smart reconnect with exponential backoff
            const delay = getBackoffDelay(globalReconnectCount);
            console.log(`   Scheduling reconnect in ${delay}ms...`);
            globalReconnectCount++;

            reconnectTimeoutRef.current = setTimeout(() => {
              setConnectionState((prev) => ({ ...prev, connecting: false }));
              if (globalReconnect) {
                globalReconnect(endpoint).catch(console.error);
              }
            }, delay);
          };

          timeoutId = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              reject(new Error(`WebSocket connection timeout after ${Math.min(5000 + globalReconnectCount * 2000, 15000)}ms`));
            }
          }, Math.min(5000 + globalReconnectCount * 2000, 15000));

          wsProvider.on("error", handleError);
          wsProvider.on("connected", handleConnected);
          wsProvider.on("disconnected", handleDisconnected);
        });

        // Set a fallback timeout that triggers a retry attempt if taking too long
        // This creates a race between the main connection and a faster fallback
        fallbackTimeoutRef.current = setTimeout(() => {
          console.log("⚡ Fallback: Connection taking too long, will retry after timeout expires");
        }, timeoutMs * 0.7); // 70% of main timeout

        // Wait for WebSocket to connect
        await connectionPromise;
        connectionSucceeded = true;

        console.log("📦 Creating API...");
        const api = await ApiPromise.create({
          provider: wsProvider,
          // Don't wait for connection in create - we already have it
          throwOnConnect: false,
          noInitWarn: true,
        });
        apiRef.current = api;

        // Initialize subscriptions in the background WITHOUT waiting
        // This allows the app to be responsive immediately
        (async () => {
          try {
            console.log("⏳ Setting up block subscriptions (background)...");

            // Start subscriptions without blocking the main connection flow
            const unsubscribe = await api.rpc.chain.subscribeNewHeads((header) => {
              setState((prev) => ({
                ...prev,
                blockNumber: BigInt(header.number.toString()),
              }));
            });

            unsubscribeRef.current = unsubscribe;
            console.log("✅ Block subscriptions ready!");
          } catch (error) {
            console.warn("⚠️ Failed to setup block subscriptions:", error);
            // Continue anyway - subscriptions are non-critical
          }
        })();

        // Mark as connected immediately - don't wait for subscriptions
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

        // Reset reconnect counter on successful connection
        globalReconnectCount = 0;

        // Start aggressive heartbeat check
        setupHeartbeat();

        console.log("🎉 Connection established successfully (ready to use)!");
      } catch (error) {
        console.error("❌ Connection error:", error);

        if (!connectionSucceeded) {
          setConnectionState((prev) => ({
            ...prev,
            connecting: false,
            connected: false,
          }));

          setState((prev) => ({
            ...prev,
            isConnected: false,
            isConnecting: false,
          }));

          // Schedule smart reconnect with exponential backoff
          const delay = getBackoffDelay(globalReconnectCount);
          console.log(`   Scheduling reconnect in ${delay}ms... (exponential backoff)`);
          globalReconnectCount++;

          reconnectTimeoutRef.current = setTimeout(() => {
            setConnectionState((prev) => ({ ...prev, connecting: false }));
            if (globalReconnect) {
              globalReconnect(endpoint).catch(console.error);
            }
          }, delay);
        }
      } finally {
        if (fallbackTimeoutRef.current) {
          clearTimeout(fallbackTimeoutRef.current);
          fallbackTimeoutRef.current = null;
        }
      }
    },
    [setState, setupHeartbeat]
  );

  // Store endpoint and reconnect function globally for manual refresh
  useEffect(() => {
    globalEndpoint = wssEndpoint;
    globalReconnect = connect;
  }, [wssEndpoint, connect]);

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

      if (fallbackTimeoutRef.current) {
        clearTimeout(fallbackTimeoutRef.current);
        fallbackTimeoutRef.current = null;
      }

      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
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
