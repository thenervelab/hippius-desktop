"use client";

import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import BoxSimple from "../ui/icons/BoxSimple";
import { RevealTextLine } from "../ui";
import { InView } from "react-intersection-observer";
import { IPFS_NODE_CONFIG } from "@/app/lib/config";
import NotificationMenu from "./notifications-menu";

const BlockchainStats: React.FC = () => {
  const { isConnected } = usePolkadotApi();
  const [peerCount, setPeerCount] = useState<number | null>(null);

  useEffect(() => {
    const fetchPeers = () => {
      fetch(`${IPFS_NODE_CONFIG.baseURL}/api/v0/swarm/peers`, {
        method: "POST",
      })
        .then((res) => res.json())
        .then((response) => {
          setPeerCount(response?.Peers.length);
        })
        .catch(() => setPeerCount(null));
    };

    fetchPeers();

    const intervalId = setInterval(fetchPeers, 1000);

    return () => clearInterval(intervalId);
  }, []);

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
