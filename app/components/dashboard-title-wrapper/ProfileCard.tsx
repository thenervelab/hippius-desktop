"use client";
import React from "react";
import { toast } from "sonner";
import BoxSimple from "@/components/ui/icons/BoxSimple";
import { Icons } from "@/components/ui";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { openAppLink } from "@/lib/utils/links";
import dynamic from "next/dynamic";
const Avatar = dynamic(() => import("boring-avatars"), { ssr: false });
const ProfileCard: React.FC = () => {
  const { polkadotAddress } = useWalletAuth();
  const { blockNumber, isConnected } = usePolkadotApi();

  const handleCopyAddress = () => {
    if (!polkadotAddress) return;

    navigator.clipboard.writeText(polkadotAddress).then(() => {
      toast.success("Copied to clipboard successfully!");
    });
  };

  const handleSendIconClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const accountPageUrl = `https://hipstats.com/accounts/${polkadotAddress}`;

    try {
      await openAppLink(accountPageUrl);
    } catch (error) {
      console.error("Failed to open account page:", error);
      toast.error("Failed to open account page");
    }
  };

  if (polkadotAddress) {
    return (
      <div className="flex">
        <div className="bg-white hover:bg-primary-100/60 animate-fade-in-0.3 flex items-center gap-x-2 duration-300 transition-colors rounded-full">
          <div className="size-10 font-medium flex items-center justify-center cursor-pointer">
            <Avatar
              colors={["#D3DFF8", "#183E91", "#3167DE", "#A6F4C5"]}
              name={polkadotAddress}
              size={40}
              variant="pixel"
            />
          </div>
          <div className="py-1 pl-1 pr-2">
            <div className="flex gap-0">
              <button
                onClick={handleCopyAddress}
                className=" rounded-l-full font-semibold"
              >

                <span className="cursor-pointer">
                  {polkadotAddress.slice(0, 6)}...
                  {polkadotAddress.slice(polkadotAddress.length - 5)}
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
        <button
          onClick={handleSendIconClick}
          className="mt-1 hover:scale-110 rounded-full duration-300 rounded-r-full p-1 flex justify-center transition-colors"
        >
          <Icons.Send className="size-4 text-primary-10" />
        </button>
      </div >
    );
  }
};

export default ProfileCard;
