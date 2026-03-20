"use client";

import React from "react";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import VPNSwitch from "./VPNSwitch";
import VPNStatusIndicator from "./VPNStatusIndicator";
import { vpnConnectedAtom, vpnLoadingAtom } from "./vpnAtoms";
import { RevealTextLine } from "@/app/components/ui";
import { InView } from "react-intersection-observer";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import { toast } from "sonner";

interface VpnStatus {
  is_enabled: boolean;
}

const VPNMenuContent = () => {
  const [isConnected, setIsConnected] = useAtom(vpnConnectedAtom);
  const [isLoading, setIsLoading] = useAtom(vpnLoadingAtom);
  const { data: credits, isFetching, isLoading: isCreditsLoading } = useUserCredits();

  const handleToggle = async (checked: boolean) => {
    // Check if user has at least 10 credits before enabling VPN
    if (checked && (isCreditsLoading || isFetching)) {
      toast.error("Credits Loading", {
        description: "Please wait while we load your credits balance.",
      });
      return;
    }
    if (checked && credits !== undefined) {
      const creditsNumber = Number(credits) / Math.pow(10, 18);
      if (creditsNumber < 10) {
        toast.error("Insufficient Credits", {
          description: "You need at least 10 credits to use the VPN feature.",
        });
        return;
      }
    }

    setIsLoading(true);
    try {
      const status = await invoke<VpnStatus>("toggle_vpn_status");
      setIsConnected(status.is_enabled);

    } catch (error) {
      let backendMessage: string;
      if (error instanceof Error) {
        backendMessage = error.message;
      } else if (typeof error === "string") {
        backendMessage = error;
      } else {
        try {
          backendMessage = String(error);
        } catch {
          backendMessage = "An unknown error occurred";
        }
      }
      toast.error("Failed to toggle VPN", {
        description: backendMessage,
      });
      console.error("Failed to toggle VPN status:", error);
      // Revert on error
      setIsConnected(!checked);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div>
          <div
            ref={ref}
            className="w-full bg-grey-100 rounded-lg overflow-hidden flex flex-col"
          >
            {/* Header / Visual Area */}
            <div className="relative h-[184px] bg-primary-100 m-4 mb-0 rounded-lg overflow-hidden shrink-0">
              {/* Grid Background */}
              <div className="absolute inset-0">
                <Image
                  src="/vpn-grid.png"
                  alt="Grid Background"
                  fill
                  className="object-cover"
                />
              </div>

              {/* Globe */}
              <div className="absolute left-1/2  top-[80px] -translate-x-1/2 w-[437px] h-[400px] pointer-events-none z-20">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{
                    duration: 50,
                    repeat: Infinity,
                    ease: "linear",
                  }}
                >
                  <Image
                    src="/globe.png"
                    alt="Globe"
                    width={437}
                    height={400}
                    className="object-contain object-top rotate-[-20deg]"
                    priority
                    quality={100}
                    loading="eager"
                  />
                </motion.div>
              </div>
              {/* Title */}
              <div className="absolute top-[22px] left-0 right-0 flex justify-center z-10">
                <RevealTextLine reveal={inView} delay={100}>
                  <h2 className="font-semibold text-2xl text-primary-50 leading-8">
                    Hippius Secure Tunnel
                  </h2>
                </RevealTextLine>
              </div>
            </div>

            {/* Content Area */}
            <div className="p-4 pt-0 flex flex-col gap-4">
              {/* Description */}
              <div className="text-center mt-4 flex flex-col items-center">
                <RevealTextLine reveal={inView} delay={200}>
                  <h3 className="font-medium text-[22px] leading-8 text-grey-10 mb-1">
                    Encrypted Access to Hippius
                  </h3>
                </RevealTextLine>
                <RevealTextLine reveal={inView} delay={300}>
                  <p className="font-medium text-base leading-[22px] text-grey-50 tracking-[-0.32px] text-center max-w-[320px]">
                    This tunnel provides authenticated, end-to-end encrypted
                    connectivity to the entire Hippius mesh.
                  </p>
                </RevealTextLine>
              </div>

              {/* Status Bar */}
              <div className="flex items-center justify-between px-2 py-1.5 bg-grey-100 border border-grey-80 rounded-[4px]">
                <RevealTextLine reveal={inView} delay={400}>
                  <span className="font-medium text-base leading-[22px] text-grey-50 tracking-[-0.32px]">
                    {isConnected ? "Your VPN is On" : "Your VPN is Off"}
                  </span>
                </RevealTextLine>

                <VPNSwitch
                  checked={isConnected}
                  onCheckedChange={handleToggle}
                  loading={isLoading}
                />
              </div>

              {/* Connected Status Details (Only when connected) */}
              <AnimatePresence initial={false}>
                {isConnected && (
                  <motion.div
                    key="vpn-status"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{
                      height: { duration: 0.15, ease: "easeInOut" },
                      opacity: { duration: 0.1, ease: "easeInOut" },
                    }}
                    style={{ overflow: "hidden" }}
                  >
                    <VPNStatusIndicator />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>


        </div>
      )}
    </InView>
  );
};

export default VPNMenuContent;
