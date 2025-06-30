"use client";

import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { usePolkadotApi } from "@/lib/polkadot-api-context";

const BlockchainStats: React.FC = () => {
  const { api, isConnected, blockNumber } = usePolkadotApi();
  const [peerCount, setPeerCount] = useState<number | null>(null);

  useEffect(() => {
    if (api && isConnected) {
      // Fetch peer count from the node
      api.rpc.system
        .peers()
        .then((peers) => setPeerCount(peers.length))
        .catch(() => setPeerCount(null));
    } else {
      setPeerCount(null);
    }
  }, [api, isConnected]);

  return (
    <div className="flex space-x-4 mb-6">
      <div className="flex items-center space-x-2">
        <Database size={16} className="text-gray-500" />
        <span className="text-xs text-gray-500">Storage:</span>
        <span className="text-xs bg-gray-100 px-2 py-1 rounded-full">
          {peerCount !== null ? `${peerCount} Peers` : "—"}
        </span>
      </div>

      <div className="flex items-center space-x-2">
        <span className="text-xs text-gray-500">Blockchain:</span>
        <span className="text-xs bg-gray-100 px-2 py-1 rounded-full">
          {isConnected ? "Connected" : "Not Connected"}
        </span>
      </div>

      <div className="flex items-center space-x-2">
        <span className="text-xs text-gray-500">Block Number:</span>
        <span className="text-xs bg-gray-100 px-2 py-1 rounded-full">
          {blockNumber !== null ? blockNumber.toString() : "—"}
        </span>
      </div>
    </div>
  );
};

export default BlockchainStats;