"use client";
import React from "react";
import { toast } from "sonner";

import { useWalletAuth } from "@/lib/wallet-auth-context";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import dynamic from "next/dynamic";
import { openAppLink } from "@/app/lib/utils/links";
import { Icons } from "../ui";
import CustomTooltip2 from "../ui/CustomTooltip2";
import BoxSimple from "../ui/icons/BoxSimple";

const Avatar = dynamic(() => import("boring-avatars"), { ssr: false });

const ProfileCard: React.FC = () => {
  const { oauthSession, polkadotAddress } = useWalletAuth();
  const { blockNumber, isConnected } = usePolkadotApi();

  // Prefer OAuth substrate address; fall back to locally-derived address for mnemonic logins.
  const displayAddress = oauthSession?.substrateAddress || polkadotAddress || null;

  const handleCopyAddress = () => {
    if (!displayAddress) return;

    const truncatedAddress = `${displayAddress.slice(
      0,
      6
    )}...${displayAddress.slice(displayAddress.length - 5)}`;

    navigator.clipboard.writeText(displayAddress).then(() => {
      toast.success(() => (
        <div>
          Address <strong>{truncatedAddress}</strong> Copied Successfully!
        </div>
      ));
    });
  };

  const handleSendIconClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const accountPageUrl = `https://hipstats.com/accounts/${displayAddress}`;

    try {
      await openAppLink(accountPageUrl);
    } catch (error) {
      console.error("Failed to open account page:", error);
      toast.error("Failed to open account page");
    }
  };

  if (displayAddress) {
    return (
      <div className="flex max-h-[50px]">
        <div
          className="bg-white hover:bg-primary-100/60 animate-fade-in-0.3 flex items-center gap-x-2 duration-300 transition-colors rounded-full cursor-pointer"
          onClick={handleCopyAddress}
        >
          <div className="size-10 font-medium flex items-center justify-center cursor-pointer">
            <Avatar
              colors={["#D3DFF8", "#183E91", "#3167DE", "#A6F4C5"]}
              name={displayAddress}
              size={40}
              variant="pixel"
            />
          </div>
          <div className="py-1 pl-1 pr-2">
            <div className="flex gap-0">
              <button className="rounded-l-full font-semibold">
                <span className="cursor-pointer">
                  {displayAddress.slice(0, 6)}...
                  {displayAddress.slice(displayAddress.length - 5)}
                </span>
              </button>
            </div>
            <div className="flex gap-x-1 items-center">
              <BoxSimple className="size-4" />
              {isConnected && (
                <span className="text-success-40 text-xs font-semibold">
                  # {blockNumber}
                </span>
              )}
            </div>
          </div>
        </div>
        <CustomTooltip2
          className="self-start"
          tooltipContent="View on Hipstats"
        >
          <button
            onClick={handleSendIconClick}
            className="mt-1 hover:scale-110 rounded-full duration-300 rounded-r-full p-1 flex justify-center transition-transform"
          >
            <Icons.Send className="size-4 text-primary-10" />
          </button>
        </CustomTooltip2>
      </div>
    );
  }
};

export default ProfileCard;
