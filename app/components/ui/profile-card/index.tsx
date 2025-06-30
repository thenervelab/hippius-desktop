import React from "react";
import Avatar from "boring-avatars";
import { toast } from "sonner";
import BoxSimple from "../icons/BoxSimple";
// import { useWalletAuth } from "@/lib/wallet-auth-context";
// import { usePolkadotApi } from "@/lib/polkadot-api-context";
const ProfileCard: React.FC = () => {
  //       const { polkadotAddress } = useWalletAuth();
  //   const { blockNumber, isConnected } = usePolkadotApi();
  // Hardcoded values instead of using context
  const hardcodedAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const hardcodedBlockNumber = 12345678;
  const hardcodedIsConnected = true;

  if (hardcodedAddress) {
    return (
      <button
        onClick={() => {
          navigator.clipboard.writeText(hardcodedAddress).then(() => {
            toast.success("Copied to clipboard successfully!");
          });
        }}
        className="animate-fade-in-0.3 flex items-center gap-x-2 bg-white hover:bg-primary-100/60 duration-300 px-3 pr-4 rounded-full"
      >
        <div className="size-10 font-medium flex items-center justify-center">
          <Avatar
            colors={["#D3DFF8", "#183E91", "#3167DE", "#A6F4C5"]}
            name={hardcodedAddress}
            variant="pixel"
          />
        </div>
        <div>
          <div className="font-semibold">
            {hardcodedAddress.slice(0, 6)}...
            {hardcodedAddress.slice(hardcodedAddress.length - 5)}
          </div>
          <div className="flex gap-x-1 items-center">
            <BoxSimple className="size-4" />
            {hardcodedIsConnected && (
              <span className="text-success-40 text-xs font-semibold">
                # {hardcodedBlockNumber}
              </span>
            )}
          </div>
        </div>
      </button>
    );
  }
};

export default ProfileCard;
