"use client";

import React from "react";
import Image from "next/image";
import { motion } from "framer-motion";
import { useAtom } from "jotai";
import VPNSwitch from "./VPNSwitch";
import VPNStatusIndicator from "./VPNStatusIndicator";
import { vpnConnectedAtom } from "./vpnAtoms";
import { RevealTextLine } from "@/app/components/ui";
import { InView } from "react-intersection-observer";

const VPNMenuContent = () => {
  const [isConnected, setIsConnected] = useAtom(vpnConnectedAtom);

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="w-full bg-white rounded-lg overflow-hidden flex flex-col"
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
            <div className="flex items-center justify-between px-2 py-1.5 bg-white border border-grey-80 rounded-[4px]">
              <RevealTextLine reveal={inView} delay={400}>
                <span className="font-medium text-base leading-[22px] text-grey-50 tracking-[-0.32px]">
                  {isConnected ? "Your VPN is On" : "Your VPN is Off"}
                </span>
              </RevealTextLine>

              <VPNSwitch
                checked={isConnected}
                onCheckedChange={setIsConnected}
              />
            </div>

            {/* Connected Status Details (Only when connected) */}
            {isConnected && <VPNStatusIndicator />}
          </div>
        </div>
      )}
    </InView>
  );
};

export default VPNMenuContent;
