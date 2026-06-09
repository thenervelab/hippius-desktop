"use client";
import React, { useEffect, useRef, useState } from "react";
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
import {
  ChevronDown,
  Setting,
  Logout,
  TrendUp,
  Copy,
  Check,
} from "@/components/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

  // Copy-address feedback: the menu item's icon cross-fades into a green check
  // for ~2s. Kept in state (not just a toast) so the result shows inline in the
  // still-open menu — the address itself is no longer displayed in the menu.
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear a pending reset if the card unmounts mid-animation.
  useEffect(
    () => () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    },
    [],
  );

  // Prefer OAuth substrate address; fall back to locally-derived address for mnemonic logins.
  const displayAddress =
    oauthSession?.substrateAddress || polkadotAddress || null;

  // Center truncation with an equal number of leading/trailing characters.
  // The address span is never CSS-clipped, so the trailing half always
  // survives — only this middle ellipsis shortens the address.
  const truncatedAddress = displayAddress
    ? `${displayAddress.slice(0, 6)}...${displayAddress.slice(
        displayAddress.length - 6,
      )}`
    : "";

  // Mark copied + schedule the 2s reset (shared by both copy paths).
  const markCopied = () => {
    setCopied(true);
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopied(false), 2000);
  };

  // Copy the address from inside the menu. preventDefault stops Radix closing
  // the menu on select so the Copy→Check swap stays visible. Falls back to a
  // temporary <textarea> where the async clipboard API isn't available.
  const handleCopyAddress = (e: Event) => {
    e.preventDefault();
    if (!displayAddress) return;

    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(displayAddress)
        .then(markCopied)
        .catch((err) => {
          console.error(err);
          toast.error("Failed to copy");
        });
      return;
    }

    const ta = document.createElement("textarea");
    ta.value = displayAddress;
    ta.style.position = "fixed";
    ta.style.left = "-999999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      markCopied();
    } catch (err) {
      console.error(err);
      toast.error("Failed to copy");
    } finally {
      ta.remove();
    }
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

  // Shared avatar + address + block-number block. The chevron, when present,
  // sits on the address line itself so it aligns with the address rather than
  // floating in the vertical centre of the two-line card.
  const renderIdentity = (withChevron: boolean) => (
    <span className="flex flex-col items-start min-w-0 flex-1">
      <span className="flex items-center gap-1.5">
        <span className="text-sm font-medium font-inter leading-none text-zinc-800 dark:text-grey-light-600 tracking-[-0.4px] whitespace-nowrap text-left">
          {truncatedAddress}
        </span>
        {withChevron && (
          <ChevronDown className="size-[12px] shrink-0 text-black-700/60 dark:text-grey-light-300/60 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        )}
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
              "group flex items-center gap-1.5 rounded-lg py-2 hover:bg-black/5 transition-colors duration-200 min-w-0 overflow-hidden",
              "dark:hover:bg-white/10 data-[state=open]:bg-black/5 dark:data-[state=open]:bg-white/10",
              collapsed ? "px-1" : "flex-1 pr-1",
            )}
          >
            {avatarNode}
            {!collapsed && renderIdentity(true)}
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
          "rounded-[8px] border border-grey-dark-100 bg-white p-1 z-[1100]",
          // Match the menu to the trigger row (avatar + address + block +
          // chevron) via Radix's measured trigger width. Collapsed, the trigger
          // is just the avatar, so fall back to a fixed width that fits the items.
          collapsed
            ? "w-[238px]"
            : "w-[var(--radix-dropdown-menu-trigger-width)]",
          "shadow-[0_4px_24px_0_rgba(0,0,0,0.08)]",
          "dark:border-[#313131] dark:bg-[#161616]",
        )}
      >
        {/* Copy address replaces the old avatar/address/block header. The copy
            icon cross-fades into a green check (handler preventDefaults so the
            menu stays open to show it). No separator per design. */}
        <DropdownMenuItem
          onSelect={handleCopyAddress}
          aria-label="Copy address"
          className={menuItemClass}
        >
          <span className="relative size-4 shrink-0">
            <Copy
              className={cn(
                "absolute inset-0 size-4 transition-all duration-200 ease-out",
                copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
              )}
            />
            <Check
              className={cn(
                "absolute inset-0 size-4 text-emerald-500 dark:text-emerald-400 transition-all duration-200 ease-out",
                copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
              )}
            />
          </span>
          <span>{copied ? "Copied!" : "Copy address"}</span>
        </DropdownMenuItem>

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
