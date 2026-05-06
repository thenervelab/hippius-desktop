"use client";

import { useEffect } from "react";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button/ButtonV2";
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
    <Button
      type="button"
      variant="defaultStable"
      size="auto"
      className={cn(
        "relative inline-flex items-center justify-center gap-[7px] px-[10px] py-[8px]",
        "rounded-[8px] border border-grey-dark-100 dark:border-black-300",
        "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16),0px_1px_0px_0px_white,0px_1px_0px_0px_white]",
        "dark:shadow-[0px_0px_0px_1px_black]",
        "bg-[#fefefe] text-black-600 hover:bg-[#fefefe] hover:rounded-[8px]",
        "dark:bg-black-primary-bg dark:text-grey-dark-400 dark:hover:bg-black-primary-bg",
        "transition-colors duration-150 active:translate-y-0 active:scale-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50 focus-visible:ring-offset-2",
        isConnected &&
          "bg-primary-50 border-primary-50 text-white hover:bg-primary-50 dark:bg-primary-50 dark:border-primary-50 dark:text-white dark:hover:bg-primary-50",
        className,
      )}
    >
      <span className="font-medium text-[14px] leading-[1.109] tracking-[-0.28px] whitespace-nowrap">
        VPN
      </span>
    </Button>
  );
};

export default VPNIconButton;
