import React, { useEffect, useState } from "react";
import { InView } from "react-intersection-observer";
import { RevealTextLine } from "@/app/components/ui";
import { invoke } from "@tauri-apps/api/core";
import Lock from "../../ui/icons/Lock";
import { TrendUp, TrendDown, Refresh, Globe } from "@/app/components/ui/icons";
import { formatBytes } from "@/app/lib/utils";

interface NebulaStats {
  udp_tx_bytes: number;
  udp_rx_bytes: number;
}

const VPNStatusIndicator = () => {
  const [ip, setIp] = useState<string>("");
  const [stats, setStats] = useState<NebulaStats | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchData = async () => {
    setIsRefreshing(true);
    try {
      const [ipResult, statsResult] = await Promise.all([
        invoke<string>("get_nebula_ip"),
        invoke<NebulaStats>("get_nebula_stats"),
      ]);
      setIp(ipResult);
      setStats(statsResult);
    } catch (e) {
      console.error("Failed to fetch VPN data:", e);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => {
      invoke<NebulaStats>("get_nebula_stats")
        .then(setStats)
        .catch(console.error);
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="flex flex-col gap-4 w-full">
          {/* Status Row */}
          <div className="flex items-center justify-center gap-3">
            {/* Connected Part */}
            <RevealTextLine reveal={inView} delay={100}>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-2 rounded-lg">
                  <span className="p-1 rounded-full bg-success-70">
                    <span className="block w-1.5 h-1.5 rounded-full bg-success-50"></span>
                  </span>
                </span>
                <span className="font-medium text-[15px] leading-5 text-grey-10">
                  Connected
                </span>
              </div>
            </RevealTextLine>

            {/* Divider */}
            <RevealTextLine reveal={inView} delay={200}>
              <div className="w-[1px] h-5 bg-grey-70" />
            </RevealTextLine>

            {/* Encrypted Part */}
            <RevealTextLine reveal={inView} delay={300}>
              <div className="flex items-center gap-2">
                <Lock className="w-3.5 h-3.5 text-grey-10" />
                <span className="font-medium text-[15px] leading-5 text-grey-10">
                  Encrypted
                </span>
              </div>
            </RevealTextLine>
          </div>

          {/* IP Address Card */}
          <RevealTextLine
            reveal={inView}
            delay={400}
            parentClassName="w-full block"
            className="w-full block"
          >
            <div className="bg-grey-95 border border-grey-80 rounded-lg py-3 px-4 flex flex-col items-center gap-2 w-full">
              <div className="flex items-center gap-2">
                <Globe className="size-4 text-grey-50" />
                <span className="text-xs translate-y-0.5 font-medium text-grey-50">
                  IP Address
                </span>
              </div>
              <span className="font-mono text-base font-semibold text-grey-10">
                {ip || "Loading..."}
              </span>
            </div>
          </RevealTextLine>

          {/* Stats Cards Grid */}
          <div className="grid grid-cols-2 gap-2.5 w-full">
            {/* Sent Card */}
            <RevealTextLine
              reveal={inView}
              delay={500}
              parentClassName="w-full block"
              className="w-full block"
            >
              <div className="bg-primary-100/40 border border-primary-80/40 rounded-lg py-2.5 px-2 flex flex-col items-center gap-1.5 w-full">
                <div className="flex items-center gap-1.5">
                  <div className="p-1 bg-primary-50 rounded-md">
                    <TrendUp className="size-3.5 text-white" />
                  </div>
                  <span className="text-[11px] font-medium text-grey-50">
                    Sent
                  </span>
                </div>
                <span className="font-mono text-sm font-semibold text-grey-10">
                  {stats ? formatBytes(stats.udp_tx_bytes) : "0 B"}
                </span>
              </div>
            </RevealTextLine>

            {/* Received Card */}
            <RevealTextLine
              reveal={inView}
              delay={550}
              parentClassName="w-full block"
              className="w-full block"
            >
              <div className="bg-success-100 border border-success-80 rounded-lg py-2.5 px-2 flex flex-col items-center gap-1.5 w-full">
                <div className="flex items-center gap-1.5">
                  <div className="p-1 bg-success-50 rounded-md">
                    <TrendDown className="size-3.5 text-white" />
                  </div>
                  <span className="text-[11px] font-medium text-grey-50">
                    Received
                  </span>
                </div>
                <span className="font-mono text-sm font-semibold text-grey-10">
                  {stats ? formatBytes(stats.udp_rx_bytes) : "0 B"}
                </span>
              </div>
            </RevealTextLine>
          </div>

          {/* Refresh Button */}
          <RevealTextLine
            reveal={inView}
            delay={600}
            parentClassName="w-full block"
            className="w-full block"
          >
            <div className="flex justify-center">
              <button
                onClick={fetchData}
                disabled={isRefreshing}
                className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-grey-50 hover:text-grey-30 transition-colors disabled:opacity-50"
                title="Refresh Stats"
              >
                <Refresh
                  className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
                />
                <span>Refresh Stats</span>
              </button>
            </div>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
};

export default VPNStatusIndicator;
