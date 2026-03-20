"use client";

import { useEffect } from "react";
import { InView } from "react-intersection-observer";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { RevealTextLine } from "@/app/components/ui";
import cn from "@/app/lib/utils/cn";
import { vpnConnectedAtom, vpnLoadingAtom } from "./vpnAtoms";

interface VpnStatus {
  is_enabled: boolean;
}

const VPNIconButton: React.FC<{
  className?: string;
}> = ({ className }) => {
  const [isConnected, setIsConnected] = useAtom(vpnConnectedAtom);
  const [, setIsLoading] = useAtom(vpnLoadingAtom);

  // Fetch VPN status on mount
  useEffect(() => {
    const fetchVpnStatus = async () => {
      setIsLoading(true);
      try {
        const status = await invoke<VpnStatus>("get_vpn_status");
        setIsConnected(status.is_enabled);
      } catch (error) {
        console.error("Failed to fetch VPN status:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchVpnStatus();
  }, [setIsConnected, setIsLoading]);
  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="flex items-center justify-center h-full mr-4">
          <RevealTextLine reveal={inView} className={className}>
            <span
              className={cn(
                "border rounded-[4px] relative flex items-center justify-center h-[36px] min-w-[36px] px-2 transition-colors duration-200",
                isConnected
                  ? "bg-primary-50 border-primary-50"
                  : "bg-grey-100 border-grey-80"
              )}
            >
              <span
                className={cn(
                  "font-medium text-[10px] leading-4 tracking-[-0.2px]",
                  isConnected ? "text-white" : "text-grey-10"
                )}
              >
                VPN
              </span>
            </span>
          </RevealTextLine>
        </div>
      )}
    </InView>
  );
};

export default VPNIconButton;
