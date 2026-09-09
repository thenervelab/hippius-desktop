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
import BoxSimple from "../ui/icons/BoxSimple";
import {
  ChevronDown,
  Setting,
  Logout,
  TrendUp,
  Copy,
  Check,
  Star,
  Google,
  Github,
  Apple,
  WalletMinimal,
} from "@/components/ui/icons";
import { resolveAccountIdentity } from "./accountIdentity";
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
import { openChannelDialog } from "@/app/components/updater/releaseChannelStore";
import { currentReleaseChannel, type ReleaseChannel } from "@/lib/tauri/updates";

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
  // The lane this build came from, read once. It is compiled into the binary,
  // so it cannot change while the app runs — a switch installs a different
  // build and restarts.
  const [channel, setChannel] = useState<ReleaseChannel | null>(null);
  const { blockNumber, isConnected } = usePolkadotApi();
  const router = useRouter();

  // Copy-address feedback: the menu item's icon cross-fades into a green check
  // for ~2s. Kept in state (not just a toast) so the result shows inline in the
  // still-open menu — the address itself is no longer displayed in the menu.
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    currentReleaseChannel()
      .then((value) => {
        if (!cancelled) setChannel(value);
      })
      // An older backend without the command. The item stays hidden rather
      // than guessing a lane and offering the wrong action.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Who the account belongs to, resolved the same way the console
  // resolves it — the sign-in identity leads and the SS58 moves to its own
  // row, because users were mistaking the address for a deposit address.
  const identity = resolveAccountIdentity(oauthSession, displayAddress ?? "");
  const { truncatedAddress } = identity;
  const ProviderIcon =
    oauthSession?.provider === "google"
      ? Google
      : oauthSession?.provider === "github"
        ? Github
        : oauthSession?.provider === "apple"
          ? Apple
          : null;

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

  // Open the account page on the Hipstats explorer.
  const openHipstatsAccount = async () => {
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

  const handleExploreBeta = () => {
    openChannelDialog();
  };

  const handleOpenSettings = () => {
    router.push("/settings?section=sync");
  };

  const handleSignOut = () => {
    void logout();
  };

  if (!displayAddress) return null;

  const avatarNode = (
    // relative so the avatar paints above the absolutely-positioned hover
    // layer in the expanded trigger (positioned, z-auto → later in paint order).
    <span className="relative size-[30px] rounded-full overflow-hidden flex-shrink-0">
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
    // relative: paint above the trigger's hover layer (see avatarNode).
    // overflow-hidden: the trigger itself must stay overflow-visible (it
    // would clip the hover layer), so text clipping lives here instead.
    <span className="relative flex flex-col items-start min-w-0 flex-1 overflow-hidden">
      <span className="flex items-center gap-1.5">
        {/* The sign-in identity for an OAuth account, the address for a
            mnemonic one. `truncate` rather than `whitespace-nowrap` alone:
            an email is longer than an SS58 and has to be allowed to clip
            inside the rail. */}
        <span className="min-w-0 truncate text-sm font-medium font-inter leading-none text-zinc-800 dark:text-grey-light-600 tracking-[-0.4px] text-left">
          {identity.primary}
        </span>
        {withChevron && (
          <ChevronDown className="size-[12px] shrink-0 text-black-700/60 dark:text-grey-light-300/60 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        )}
      </span>
      {/* The address, under the sign-in identity — the console's layout.
          It used to carry the chain's block height instead, which said
          nothing about the account and left the address nowhere on the
          card. The block height moves into the menu, where it is still
          one click away without competing with the identity. */}
      <span className="flex items-center gap-1 mt-1 w-full min-w-0">
        <BoxSimple className="size-[13px] text-black-700 dark:text-grey-light-600 flex-shrink-0" />
        <span className="min-w-0 truncate text-[10px] font-medium leading-[14px] text-primary-50 dark:text-primary-brand-dark tracking-[-0.2px]">
          {truncatedAddress}
        </span>
      </span>
    </span>
  );

  const menuItemClass = cn(
    "h-8 rounded-[8px] px-3 py-1.5 gap-2 cursor-pointer",
    "text-[14px] font-medium leading-4 tracking-[-0.4px]",
    // Radix toggles the highlighted item via data-highlighted (mouse AND
    // keyboard), not :hover — the base item's hover:bg only coincidentally
    // works. Style the real attribute so the highlight shows in both themes.
    "text-[#52525c] data-[highlighted]:!text-grey-10 data-[highlighted]:!bg-[#e9e9e9]",
    "dark:text-[#a3a3a3] dark:data-[highlighted]:!text-white dark:data-[highlighted]:!bg-[#2c2c2c]",
  );

  return (
    <DropdownMenu>
      <div
        className={cn(
          // No overflow-hidden: it would clip the hover pill's bleed flat.
          // Text clipping is handled inside renderIdentity instead.
          "flex items-center gap-1.5 w-full h-11",
          // Center the avatar in the collapsed rail. Without this it's
          // left-aligned and the px-0 button (30px) sits flush-left, looking
          // clipped against the rail edge at high zoom.
          (centered || collapsed) && "justify-center",
        )}
      >
        {/* The entire identity card is the trigger: clicking anywhere on it
            opens the menu. Copy is no longer bound to this click. */}
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open account menu"
            className={cn(
              // No focus ring (Radix returns focus here on close; a ring
              // showed the browser/brand blue as a clipped bar).
              "group flex items-center outline-none",
              // Collapsed: a fixed 36px circle around the 30px avatar — the
              // hover surface is a concentric halo painted by the button
              // itself. rem-sized like the rail, so it scales 1:1 at every
              // zoom level.
              // Expanded: the button is a LAYOUT-ONLY box — no padding,
              // margin, or background, so the avatar/address can never drift
              // out of alignment with the footer. The glassy hover pill is the
              // absolutely-positioned layer below, decoupled from layout.
              // self-stretch fills the 44px row so :hover covers the whole
              // row height, not just the 30px content band.
              collapsed
                ? cn(
                    "size-9 shrink-0 justify-center rounded-full transition-colors duration-200",
                    "hover:bg-white/30 focus-visible:bg-white/30 data-[state=open]:bg-white/30",
                    "dark:hover:bg-white/10 dark:focus-visible:bg-white/10 dark:data-[state=open]:bg-white/10",
                  )
                : "relative flex-1 self-stretch gap-1.5 min-w-0",
            )}
          >
            {!collapsed && (
              // Glass pill matching the nav links' surface (NavItem:
              // hover:bg-white/30 dark:hover:bg-white/10), spanning the full
              // 44px row and 10px past the content on both sides (the links'
              // p-[10px] inset) — within the footer's px-6 gutters. Out of
              // flow, so the row's gap and metrics ignore it. It deliberately
              // KEEPS pointer events: as a child of the trigger, hovering or
              // clicking the pill's bleed makes the button itself :hover /
              // receive the click, so the whole visual pill is interactive —
              // exactly like the links' padded box.
              <span
                aria-hidden
                className={cn(
                  "absolute -inset-x-[10px] inset-y-0 rounded-[6px] transition-colors duration-200",
                  "group-hover:bg-white/30 group-focus-visible:bg-white/30 group-data-[state=open]:bg-white/30",
                  "dark:group-hover:bg-white/10 dark:group-focus-visible:bg-white/10 dark:group-data-[state=open]:bg-white/10",
                )}
              />
            )}
            {avatarNode}
            {!collapsed && renderIdentity(true)}
          </button>
        </DropdownMenuTrigger>
      </div>

      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className={cn(
          "w-[200px] rounded-[8px] border border-grey-dark-100 bg-white p-1 z-[1100]",
          // Match the menu to the trigger row (avatar + address + block +
          // chevron) via Radix's measured trigger width. Collapsed, the trigger
          // is just the avatar, so fall back to a fixed width that fits the items.
          // A minimum rather than the trigger's width: the header's name +
          // provider badge and the address row are both wider than the
          // collapsed rail, and matching the trigger clipped them.
          collapsed
            ? "w-[248px]"
            : "min-w-[248px] w-[max(248px,var(--radix-dropdown-menu-trigger-width))]",
          "shadow-[0_4px_24px_0_rgba(0,0,0,0.08)]",
          "dark:border-[#313131] dark:bg-[#161616]",
        )}
      >
        {/* Who the account belongs to. Only for an account that HAS a
            sign-in identity — a mnemonic account would show its address
            twice, once here and once on the row below. */}
        {identity.isOAuthAccount && (
          <>
            <div className="flex items-center gap-2 px-3 pb-2 pt-2">
              <span className="flex shrink-0 overflow-hidden rounded-full">
                <Avatar
                  colors={["#D3DFF8", "#183E91", "#3167DE", "#A6F4C5"]}
                  name={displayAddress}
                  size={32}
                  variant="pixel"
                />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-geist text-[13px] font-medium leading-[1.2] tracking-[-0.28px] text-grey-10 dark:text-white">
                    {identity.menuName}
                  </span>
                  {identity.providerLabel && (
                    <span className="flex shrink-0 items-center gap-1 rounded-full border border-[#e3e3e3] bg-[#f5f5f5] px-1.5 py-0.5 dark:border-[#313131] dark:bg-[#222222]">
                      {/* GitHub and Apple are monochrome marks drawn in
                          currentColor, so they need a colour to stand out
                          on the badge; Google is multicolour and ignores
                          it. */}
                      {ProviderIcon && (
                        <ProviderIcon className="size-3 shrink-0 text-grey-10 dark:text-white" />
                      )}
                      <span className="font-geist text-[10px] font-medium leading-none text-[#52525c] dark:text-[#a3a3a3]">
                        {identity.providerLabel}
                      </span>
                    </span>
                  )}
                </span>
                {identity.menuEmail && (
                  <span className="mt-0.5 truncate font-geist text-[11px] font-medium leading-4 tracking-[-0.2px] text-[#52525c] dark:text-[#a3a3a3]">
                    {identity.menuEmail}
                  </span>
                )}
              </span>
            </div>
            <div className="mx-1 mb-1 h-px bg-[#e3e3e3] dark:bg-[#313131]" />
          </>
        )}

        {/* The address IS the row: wallet mark → address → copy/check.
            Clicking anywhere on it copies the full SS58, and the handler
            preventDefaults so the menu stays open for the crossfade. It
            replaces the old "Copy address" label, which named the action
            without ever showing what would be copied. */}
        <DropdownMenuItem
          onSelect={handleCopyAddress}
          aria-label={`Copy ${truncatedAddress} wallet address`}
          className={menuItemClass}
        >
          <WalletMinimal className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left font-geist">
            {copied ? "Copied!" : truncatedAddress}
          </span>
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
        </DropdownMenuItem>

        {/* The chain height, displaced from the card when the address took
            its line. Not a menu item: there is nothing to click, and
            making it one would put a dead row in the keyboard order. */}
        {isConnected && blockNumber != null && (
          <div className="flex items-center gap-2 px-3 pb-1.5 pt-0.5">
            <BoxSimple className="size-4 shrink-0 text-black-700/50 dark:text-grey-light-600/50" />
            <span className="font-geist text-[11px] font-medium leading-4 tracking-[-0.2px] text-[#52525c] dark:text-[#a3a3a3]">
              Block # {blockNumber.toString()}
            </span>
          </div>
        )}

        <DropdownMenuItem
          onSelect={() => void openHipstatsAccount()}
          className={menuItemClass}
        >
          <Icons.Send className="size-4 shrink-0" />
          <span>View on Hipstats</span>
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={handleOpenUpdate} className={menuItemClass}>
          <TrendUp className="size-4 shrink-0" />
          <span>Update App</span>
        </DropdownMenuItem>

        {/* Hidden on the internal lane, which cannot switch: it publishes no
            manifest, so there is nothing to install in either direction. */}
        {channel !== null && channel !== "staging" && (
          <DropdownMenuItem
            onSelect={handleExploreBeta}
            className={menuItemClass}
          >
            <Star className="size-4 shrink-0" />
            {/* Label names what the item DOES, so it never claims to join a
                channel the user is already on. */}
            <span>{channel === "beta" ? "Leave Beta" : "Explore Beta"}</span>
          </DropdownMenuItem>
        )}

        <DropdownMenuItem onSelect={handleOpenSettings} className={menuItemClass}>
          <Setting className="size-4 shrink-0" />
          <span>Settings</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={handleSignOut}
          className={cn(
            "h-8 rounded-[8px] px-3 py-1.5 gap-2 cursor-pointer",
            "text-[14px] font-medium leading-4 tracking-[-0.4px]",
            "!text-[#fc7d73] data-[highlighted]:!text-[#fc7d73] data-[highlighted]:!bg-[#e9e9e9]",
            "dark:data-[highlighted]:!bg-[#2c2c2c]",
          )}
        >
          <Logout className="size-4 shrink-0" />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ProfileCard;
