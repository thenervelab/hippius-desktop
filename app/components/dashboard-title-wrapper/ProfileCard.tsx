"use client";
import React from "react";
import { toast } from "sonner";

import { useWalletAuth } from "@/lib/wallet-auth-context";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import dynamic from "next/dynamic";
import { openAppLink } from "@/app/lib/utils/links";
import cn from "@/app/lib/utils/cn";
import { Icons } from "../ui";
import CustomTooltip2 from "../ui/CustomTooltip2";
import BoxSimple from "../ui/icons/BoxSimple";

const Avatar = dynamic(() => import("boring-avatars"), { ssr: false });

interface ProfileCardProps {
  collapsed?: boolean;
  // When true, the row is horizontally centered. SidebarFooter only sets this
  // once the collapse animation has finished, so the centering doesn't
  // interfere with the in-flight transition.
  centered?: boolean;
}

const ProfileCard: React.FC<ProfileCardProps> = ({
  collapsed = false,
  centered = false,
}) => {
  const { oauthSession, polkadotAddress } = useWalletAuth();
  const { blockNumber, isConnected } = usePolkadotApi();

  // Prefer OAuth substrate address; fall back to locally-derived address for mnemonic logins.
  const displayAddress =
    oauthSession?.substrateAddress || polkadotAddress || null;

  const handleCopyAddress = () => {
    if (!displayAddress) return;

    const truncatedAddress = `${displayAddress.slice(
      0,
      6,
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

  if (!displayAddress) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 w-full overflow-hidden h-11",
        centered && "justify-center",
      )}
    >
      <button
        type="button"
        onClick={handleCopyAddress}
        className={cn(
          "flex items-center gap-1.5 rounded-lg py-2 hover:bg-black/5 transition-colors duration-200 min-w-0 overflow-hidden",
          !collapsed && "flex-1",
        )}
      >
        <span className="size-[30px] rounded-full overflow-hidden flex-shrink-0">
          <Avatar
            colors={["#D3DFF8", "#183E91", "#3167DE", "#A6F4C5"]}
            name={displayAddress}
            size={30}
            variant="pixel"
          />
        </span>
        {!collapsed && (
          <span className="flex flex-col items-start min-w-0 flex-1 whitespace-nowrap">
            <span className="text-sm font-medium font-inter leading-none text-zinc-800 tracking-[-0.4px] truncate w-full text-left">
              {displayAddress.slice(0, 6)}...
              {displayAddress.slice(displayAddress.length - 5)}
            </span>
            <span className="flex items-center gap-1 mt-1 whitespace-nowrap">
              <BoxSimple className="size-[13px] text-black-700 flex-shrink-0" />
              {isConnected && blockNumber != null && (
                <span className="text-[10px] font-medium leading-[14px] text-primary-50 tracking-[-0.2px]">
                  # {blockNumber.toString()}
                </span>
              )}
            </span>
          </span>
        )}
      </button>
      {!collapsed && (
        <CustomTooltip2
          className="self-center"
          tooltipContent="View on Hipstats"
        >
          <button
            onClick={handleSendIconClick}
            className=" hover:scale-110 rounded-full duration-300 p-1 flex justify-center transition-transform"
          >
            <Icons.Send className="size-4 text-zinc-500" />
          </button>
        </CustomTooltip2>
      )}
    </div>
  );
};

export default ProfileCard;
