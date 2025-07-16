"use client";

import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import BoxSimple from "../ui/icons/BoxSimple";
import { RevealTextLine } from "../ui";
import { InView } from "react-intersection-observer";
import { IPFS_NODE_CONFIG } from "@/app/lib/config";
import NotificationMenu from "./notifications-menu";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";

const BlockchainStats: React.FC = () => {
  const { isConnected } = usePolkadotApi();
  const [peerCount, setPeerCount] = useState<number | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const MAX_RETRIES = 3;

  useEffect(() => {
    let mounted = true;

    const fetchPeers = async () => {
      try {
        const response = await tauriFetch(
          `${IPFS_NODE_CONFIG.baseURL}/api/v0/swarm/peers`,
          {
            method: "POST",
          }
        );

        if (response.ok) {
          const data = await response.json();
          if (mounted) {
            setPeerCount(data.Peers?.length || 0);
            setIsRetrying(false);
            setRetryCount(0);
          }
        } else {
          throw new Error(`HTTP error ${response.status}`);
        }
      } catch (error) {
        console.warn("Failed to fetch IPFS peers:", error);

        try {
          const peersData = await invoke<{ Peers: unknown[] }>(
            "get_ipfs_peers"
          );
          if (mounted) {
            setPeerCount(peersData.Peers?.length || 0);
            setIsRetrying(false);
            setRetryCount(0);
          }
        } catch (invokeError) {
          console.error("Tauri invoke also failed:", invokeError);

          if (retryCount < MAX_RETRIES) {
            setIsRetrying(true);
            setRetryCount((prev) => prev + 1);
          } else if (mounted) {
            setPeerCount(null);
            setIsRetrying(false);
          }
        }
      }
    };

    // Initial fetch
    fetchPeers();

    const intervalId = setInterval(fetchPeers, 1000);

    let retryId: NodeJS.Timeout | null = null;
    if (isRetrying) {
      retryId = setTimeout(() => {
        if (mounted) {
          fetchPeers();
        }
      }, 2000 * retryCount);
    }

    // Clean up
    return () => {
      mounted = false;
      clearInterval(intervalId);
      if (retryId) clearTimeout(retryId);
    };
  }, [isRetrying, retryCount]);

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="flex items-center text-sm">
          <RevealTextLine reveal={inView} className="delay-100">
            <div className="flex items-center gap-2">
              <Database className="text-grey-10 size-4" />
              <span className="text-grey-10">Storage:</span>

              <span className="text-grey-60 bg-grey-80 px-2 py-1 rounded">
                {peerCount !== null ? `${peerCount} Peers` : "—"}
              </span>
            </div>
          </RevealTextLine>

          <RevealTextLine reveal={inView} className="delay-200">
            <div className="w-0.5 h-4 bg-grey-80 mx-2"></div>
          </RevealTextLine>

          <RevealTextLine reveal={inView} className="delay-300">
            <div className="flex items-center gap-2">
              <BoxSimple className="text-grey-10 size-4" />
              <span className="text-grey-10">Blockchain:</span>

              <span className="s bg-grey-80 text-grey-60 px-2 py-1 rounded">
                {isConnected ? "Connected" : "Disconnected"}
              </span>
            </div>
          </RevealTextLine>

          <RevealTextLine reveal={inView} className="delay-400">
            <div className="w-0.5 h-4 bg-grey-80 mx-2"></div>
          </RevealTextLine>

          <NotificationMenu />
        </div>
      )}
    </InView>
  );
};

export default BlockchainStats;
