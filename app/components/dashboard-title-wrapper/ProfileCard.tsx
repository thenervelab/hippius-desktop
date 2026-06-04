"use client";
import React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { useWalletAuth } from "@/lib/wallet-auth-context";
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import dynamic from "next/dynamic";
import { openAppLink } from "@/app/lib/utils/links";
import cn from "@/app/lib/utils/cn";
import { Icons } from "../ui";
import CustomTooltip2 from "../ui/CustomTooltip2";
import BoxSimple from "../ui/icons/BoxSimple";
import { ChevronDown, Setting, Logout, TrendUp } from "@/components/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  updateDialogOpenAtom,
  updateStore,
} from "@/app/components/updater/updateStore";

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
  const { oauthSession, polkadotAddress, logout } = useWalletAuth();
  const { blockNumber, isConnected } = usePolkadotApi();
  const router = useRouter();

  // Prefer OAuth substrate address; fall back to locally-derived address for mnemonic logins.
  const displayAddress =
    oauthSession?.substrateAddress || polkadotAddress || null;

  const truncatedAddress = displayAddress
    ? `${displayAddress.slice(0, 8)}...${displayAddress.slice(
        displayAddress.length - 6,
      )}`
    : "";

  // Copy lives only inside the open menu now: the row click just opens the
  // menu, so this button must not dismiss it — swallow the event and keep it
  // open long enough to show the copied state.
  const handleCopyAddress = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!displayAddress) return;

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

  const handleOpenUpdate = () => {
    updateStore.set(updateDialogOpenAtom, true);
  };

  const handleOpenSettings = () => {
    router.push("/settings?section=sync");
  };

  const handleSignOut = () => {
    void logout();
  };

  if (!displayAddress) return null;

  const avatarNode = (
    <span className="size-[30px] rounded-full overflow-hidden flex-shrink-0">
      <Avatar
        colors={["#D3DFF8", "#183E91", "#3167DE", "#A6F4C5"]}
        name={displayAddress}
        size={30}
        variant="pixel"
      />
    </span>
  );

  // Shared avatar + address + block-number block. Reused verbatim in the row
  // trigger and the menu header so the menu reads as a continuation of the row.
  const identity = (
    <span className="flex flex-col items-start min-w-0 flex-1 whitespace-nowrap">
      <span className="text-sm font-medium font-inter leading-none text-zinc-800 dark:text-grey-light-600 tracking-[-0.4px] truncate w-full text-left">
        {truncatedAddress}
      </span>
      <span className="flex items-center gap-1 mt-1 whitespace-nowrap">
        <BoxSimple className="size-[13px] text-black-700 dark:text-grey-light-600 flex-shrink-0" />
        {isConnected && blockNumber != null && (
          <span className="text-[10px] font-medium leading-[14px] text-primary-50 dark:text-primary-brand-dark tracking-[-0.2px]">
            # {blockNumber.toString()}
          </span>
        )}
      </span>
    </span>
  );

  const menuItemClass = cn(
    "h-8 rounded-[8px] px-3 py-1.5 gap-2 cursor-pointer",
    "text-[14px] font-medium leading-4 tracking-[-0.4px]",
    "text-[#52525c] hover:!text-grey-10 hover:!bg-grey-light-700",
    "dark:text-[#a3a3a3] dark:hover:!text-white dark:hover:!bg-[#2c2c2c]",
  );

  return (
    <DropdownMenu>
      <div
        className={cn(
          "flex items-center gap-1.5 w-full overflow-hidden h-11",
          centered && "justify-center",
        )}
      >
        {/* The entire identity card is the trigger: clicking anywhere on it
            opens the menu. Copy is no longer bound to this click. */}
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open account menu"
            className={cn(
              "flex items-center gap-1.5 rounded-lg py-2 hover:bg-black/5 transition-colors duration-200 min-w-0 overflow-hidden",
              "dark:hover:bg-white/10 data-[state=open]:bg-black/5 dark:data-[state=open]:bg-white/10",
              collapsed ? "px-1" : "flex-1 pr-1",
            )}
          >
            {avatarNode}
            {!collapsed && (
              <>
                {identity}
                <ChevronDown className="size-[12px] shrink-0 text-black-700/60 dark:text-grey-light-300/60" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>

        {!collapsed && (
          <CustomTooltip2
            className="self-center"
            tooltipContent="View on Hipstats"
          >
            <button
              onClick={handleSendIconClick}
              className="hover:scale-110 rounded-full duration-300 p-1 flex justify-center transition-transform"
            >
              <Icons.Send className="size-4 text-zinc-500 dark:text-grey-dark-600" />
            </button>
          </CustomTooltip2>
        )}
      </div>

      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className={cn(
          "w-[238px] rounded-[8px] border border-grey-dark-100 bg-white p-1 z-[1100]",
          "shadow-[0_4px_24px_0_rgba(0,0,0,0.08)]",
          "dark:border-[#313131] dark:bg-[#161616]",
        )}
      >
        {/* Header mirrors the row identity and is itself the copy control:
            click to copy, hovering shows the same surface as the row trigger.
            The handler keeps the menu open so the copy toast is visible. */}
        <button
          type="button"
          onClick={handleCopyAddress}
          aria-label="Copy address"
          title="Copy address"
          className="flex items-center gap-1.5 w-full px-2 py-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors duration-200 text-left"
        >
          {avatarNode}
          {identity}
        </button>

        <DropdownMenuSeparator className="my-1 bg-grey-dark-100 dark:bg-[#313131]" />

        <DropdownMenuItem onSelect={handleOpenUpdate} className={menuItemClass}>
          <TrendUp className="size-4 shrink-0" />
          <span>Update App</span>
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={handleOpenSettings} className={menuItemClass}>
          <Setting className="size-4 shrink-0" />
          <span>Settings</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={handleSignOut}
          className={cn(
            "h-8 rounded-[8px] px-3 py-1.5 gap-2 cursor-pointer",
            "text-[14px] font-medium leading-4 tracking-[-0.4px]",
            "!text-[#fc7d73] hover:!text-[#fc7d73] hover:!bg-grey-light-700",
            "dark:hover:!bg-[#2c2c2c]",
          )}
        >
          <Logout className="size-4 shrink-0" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ProfileCard;
