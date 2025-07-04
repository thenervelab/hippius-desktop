"use client";

import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import BoxSimple from "../ui/icons/BoxSimple";
import { Icons } from "../ui";

const BlockchainStats: React.FC = () => {
  const { api, isConnected } = usePolkadotApi();
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
    <div className="flex items-center text-sm ">
      <div className="flex items-center gap-2">
        <Database className="text-grey-10 size-4" />
        <span className="text-grey-10">Storage:</span>
        <span className="text-grey-60 bg-grey-80 px-2 py-1 rounded">
          {peerCount !== null ? `${peerCount} Peers` : "—"}
        </span>
      </div>
      <div className="w-0.5 h-4 bg-grey-80 mx-2"></div>
      <div className="flex items-center gap-2">
        <BoxSimple className="text-grey-10 size-4" />
        <span className="text-grey-10">Blockchain:</span>
        <span className="s bg-grey-80 text-grey-60 px-2 py-1 rounded">
          {isConnected ? "Connected" : "Not Connected"}
        </span>
      </div>
      <div className="w-0.5 h-4 bg-grey-80 mx-2"></div>
      <span className="text-grey-60 bg-grey-90 p-2.5 rounded">
        <Icons.Notification className="text-grey-70 size-4" />
      </span>
    </div>
  );
};

export default BlockchainStats;
