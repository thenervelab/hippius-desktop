"use client";

import React, { useState } from "react";
import { Lock } from "lucide-react";
import Image from "next/image";
import GraphSheetContainer from "@/app/components/ui/graphsheet";
import VPNSwitch from "./VPNSwitch";

const VPNMenuContent = () => {
  const [isConnected, setIsConnected] = useState(false);

  return (
    <div className="w-full bg-white rounded-lg overflow-hidden flex flex-col">
      {/* Header / Visual Area */}
      <div className="relative h-[184px] bg-primary-100 m-4 mb-0 rounded-lg overflow-hidden shrink-0">
        {/* Grid Background */}
        <div className="absolute inset-0 opacity-10">
          <GraphSheetContainer
            majorCell={{
              lineColor: [31, 80, 189, 1.0],
              lineWidth: 2,
              cellDim: 46,
            }}
            minorCell={{
              lineColor: [49, 103, 211, 1.0],
              lineWidth: 1,
              cellDim: 46,
            }}
            className="w-full h-full"
          />
        </div>

        {/* Globe */}
        <div className="absolute left-1/2 top-[80px] -translate-x-1/2 w-[437px] h-[400px] pointer-events-none z-20">
          <Image
            src="/globe.png"
            alt="Globe"
            width={437}
            height={400}
            className="object-contain object-top"
            priority
            quality={100}
            loading="eager"
          />
        </div>

        {/* Title */}
        <div className="absolute top-[22px] left-0 right-0 text-center z-10">
          <h2 className="font-semibold text-2xl text-primary-50 leading-8">
            Hippius Secure Tunnel
          </h2>
        </div>
      </div>

      {/* Content Area */}
      <div className="p-4 pt-0 flex flex-col gap-4">
        {/* Description */}
        <div className="text-center mt-4">
          <h3 className="font-medium text-[22px] leading-8 text-grey-10 mb-1">
            Encrypted Access to Hippius
          </h3>
          <p className="font-medium text-base leading-[22px] text-grey-50 tracking-[-0.32px]">
            This tunnel provides authenticated, end-to-end encrypted
            connectivity to the entire Hippius mesh.
          </p>
        </div>

        {/* Status Bar */}
        <div className="flex items-center justify-between px-2 py-1.5 bg-white border border-grey-80 rounded-[4px]">
          <span className="font-medium text-base leading-[22px] text-grey-50 tracking-[-0.32px]">
            {isConnected ? "Your VPN is On" : "Your VPN is Off"}
          </span>

          <VPNSwitch checked={isConnected} onCheckedChange={setIsConnected} />
        </div>

        {/* Connected Status Details (Only when connected) */}
        {isConnected && (
          <div className="flex items-center justify-center gap-2 py-2 shadow-[0px_12px_36px_0px_rgba(0,0,0,0.14)] rounded-[4px] animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-full bg-[#27AE60]" />
              <span className="font-medium text-sm leading-5 text-grey-10 tracking-[-0.28px]">
                Connected
              </span>
            </div>
            <div className="w-[1px] h-[14px] bg-grey-80 mx-1" />
            <div className="flex items-center gap-1">
              <Lock className="w-3.5 h-3.5 text-grey-10" />
              <span className="font-medium text-sm leading-5 text-grey-10 tracking-[-0.28px]">
                Encrypted
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default VPNMenuContent;
