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
  WalletMinimal,
  Github,
  Google,
  Apple,
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

// The concrete OAuth providers we can badge; the desktop session stores the
// generic "oauth" (auth/oauth.rs), so the real one is recovered from localStorage.
const OAUTH_PROVIDERS = ["google", "github", "apple"] as const;
type KnownProvider = (typeof OAUTH_PROVIDERS)[number];
const isKnownProvider = (v: string | null | undefined): v is KnownProvider =>
  !!v && (OAUTH_PROVIDERS as readonly string[]).includes(v);

/**
 * Middle-ellipsis truncation for a single line: the head shrinks and ellipsizes
 * while a fixed tail (e.g. an email's domain) always stays visible — so a long
 * `ahmadraosanawarali@gmail.com` reads as `ahmadraosan…il.com` and never loses
 * its end. Pure CSS (a `truncate` head + a `shrink-0` tail), so it adapts to the
 * available width instead of a fixed character budget. Short strings render whole.
 */
const MiddleTruncate: React.FC<{
  text: string;
  tail?: number;
  className?: string;
}> = ({ text, tail = 7, className }) => {
  if (text.length <= tail + 2) {
    return <span className={cn("min-w-0 truncate", className)}>{text}</span>;
  }
  return (
    <span className={cn("flex min-w-0 items-baseline", className)}>
      <span className="min-w-0 truncate">{text.slice(0, text.length - tail)}</span>
      <span className="shrink-0 whitespace-nowrap">{text.slice(text.length - tail)}</span>
    </span>
  );
};

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
    ? `${displayAddress.slice(0, 8)}...${displayAddress.slice(
        displayAddress.length - 8,
      )}`
    : "";

  // OAuth accounts (Google/GitHub/Apple) have a human sign-in identity; mnemonic
  // accounts don't. Show that identity in the card instead of the SS58 — users
  // were mistaking the SS58 for a deposit address and sending tokens to it. The
  // SS58 stays reachable via the wallet-address row and the menu header. Mirrors
  // the web console's ProfileCard.
  const rawProvider = oauthSession?.provider;
  const isOAuthAccount = !!rawProvider && rawProvider !== "mnemonic";
  // The concrete provider (google/github/apple) drives the badge, icon, and the
  // GitHub @handle. The desktop backend now persists the real provider on the
  // session (auth/oauth.rs), so it's read straight from there; a legacy generic
  // "oauth" tag (older sessions) yields undefined ⇒ no badge, but the account is
  // still treated as OAuth (email shown) via `isOAuthAccount` above.
  const resolvedProvider: KnownProvider | undefined = isKnownProvider(
    rawProvider,
  )
    ? rawProvider
    : undefined;

  // GitHub → "@handle"; Google/Apple → the email they signed in with.
  const signInHandle =
    resolvedProvider === "github"
      ? oauthSession?.username
        ? `@${oauthSession.username}`
        : undefined
      : oauthSession?.email;
  const displayName = oauthSession?.username || undefined;

  // Primary line in the sidebar card. OAuth: the sign-in identity (falling back
  // to name, then the address). Mnemonic: the SS58 as before.
  const primaryIdentity = isOAuthAccount
    ? signInHandle || displayName || truncatedAddress
    : truncatedAddress;

  // Menu-header detail (OAuth only): account name, email, and a small provider
  // badge (icon + "Google"/"GitHub") pinned top-right of the name.
  const menuHeaderName = displayName || signInHandle || truncatedAddress;
  const menuHeaderEmail =
    oauthSession?.email && oauthSession.email !== menuHeaderName
      ? oauthSession.email
      : undefined;

  const PROVIDER_LABELS: Record<KnownProvider, string> = {
    google: "Google",
    github: "GitHub",
    apple: "Apple",
  };
  const providerLabel = resolvedProvider
    ? PROVIDER_LABELS[resolvedProvider]
    : undefined;
  const ProviderIcon =
    resolvedProvider === "google"
      ? Google
      : resolvedProvider === "github"
        ? Github
        : resolvedProvider === "apple"
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
      {/* w-full is load-bearing: the column is `items-start`, so without it this
          row is sized to its content and the email's truncate has no width to
          shrink against (it would just overflow and clip). */}
      <span className="flex w-full min-w-0 items-center gap-1.5">
        {/* OAuth identities can be long emails — middle-truncate so the domain
            end stays visible. Mnemonic shows the already-short truncated SS58. */}
        {isOAuthAccount ? (
          <MiddleTruncate
            text={primaryIdentity}
            className="text-sm font-medium font-inter leading-none text-zinc-800 dark:text-grey-light-600 tracking-[-0.4px] text-left"
          />
        ) : (
          <span className="min-w-0 truncate text-sm font-medium font-inter leading-none text-zinc-800 dark:text-grey-light-600 tracking-[-0.4px] whitespace-nowrap text-left">
            {primaryIdentity}
          </span>
        )}
        {withChevron && (
          <ChevronDown className="size-[12px] shrink-0 text-black-700/60 dark:text-grey-light-300/60 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        )}
      </span>
      {/* OAuth: show the truncated wallet address here (secondary to the sign-in
          identity above) — the block number isn't useful in this spot, styled
          blue to match. Mnemonic accounts keep the block number / connection
          indicator. The address is a fixed short center-truncated string, so it
          needs no CSS truncation — dropping `truncate` (overflow-hidden) also
          keeps it vertically centered against the wallet icon. */}
      {isOAuthAccount ? (
        <span className="flex items-center gap-1 mt-1 whitespace-nowrap">
          <WalletMinimal className="size-[13px] shrink-0 text-black-700 dark:text-grey-light-600" />
          <span className="text-[10px] font-medium leading-[14px] text-primary-50 dark:text-primary-brand-dark tracking-[-0.2px]">
            {truncatedAddress}
          </span>
        </span>
      ) : (
        <span className="flex items-center gap-1 mt-1 whitespace-nowrap">
          <BoxSimple className="size-[13px] text-black-700 dark:text-grey-light-600 flex-shrink-0" />
          {isConnected && blockNumber != null && (
            <span className="text-[10px] font-medium leading-[14px] text-primary-50 dark:text-primary-brand-dark tracking-[-0.2px]">
              # {blockNumber.toString()}
            </span>
          )}
        </span>
      )}
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
          "rounded-[8px] border border-grey-dark-100 bg-white p-1 z-[1100]",
          // Size to the trigger row via Radix's measured trigger width, but as a
          // MIN (not fixed) width so the OAuth menu header (name + provider badge
          // + email) can grow to fit and isn't clipped. Collapsed, the trigger is
          // just the avatar, so fall back to a min width that fits the items.
          collapsed
            ? "min-w-[238px]"
            : "min-w-[var(--radix-dropdown-menu-trigger-width)]",
          "max-w-[min(320px,calc(100vw-1rem))]",
          "shadow-[0_4px_24px_0_rgba(0,0,0,0.08)]",
          "dark:border-[#313131] dark:bg-[#161616]",
        )}
      >
        {/* OAuth accounts only: a non-interactive header with the account name,
            email, and how the user signed in — so the human identity is clear
            and the SS58 below is unmistakably the wallet address. */}
        {isOAuthAccount ? (
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
                  {/* text-grey-10 dark:text-white — NOT bare text-black, which
                      emits zero CSS here and goes invisible in the light-mode
                      portal (no inherited color). */}
                  <span className="min-w-0 flex-1 truncate font-inter text-[13px] font-medium leading-[1.2] tracking-[-0.28px] text-grey-10 dark:text-white">
                    {menuHeaderName}
                  </span>
                  {/* Provider badge, pinned top-right of the name. */}
                  {providerLabel ? (
                    <span className="flex shrink-0 items-center gap-1 rounded-full border border-[#e3e3e3] bg-[#f5f5f5] px-1.5 py-0.5 dark:border-[#313131] dark:bg-[#222222]">
                      {ProviderIcon ? (
                        <ProviderIcon className="size-3 shrink-0" />
                      ) : null}
                      <span className="font-inter text-[10px] font-medium leading-none text-[#52525c] dark:text-[#a3a3a3]">
                        {providerLabel}
                      </span>
                    </span>
                  ) : null}
                </span>
                {menuHeaderEmail ? (
                  <span className="mt-0.5 truncate font-inter text-[11px] font-medium leading-4 tracking-[-0.2px] text-[#52525c] dark:text-[#a3a3a3]">
                    {menuHeaderEmail}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="mx-1 mb-1 h-px bg-[#e3e3e3] dark:bg-[#313131]" />
          </>
        ) : null}

        {/* The wallet address IS the row: wallet icon → address → copy/check.
            Clicking anywhere copies the full SS58; handleCopyAddress
            preventDefaults so the menu stays open and the Copy→Check crossfade
            is visible. Keeps the SS58 discoverable for OAuth and access-key
            users alike. */}
        <DropdownMenuItem
          onSelect={handleCopyAddress}
          aria-label={`Copy ${truncatedAddress} wallet address`}
          className={menuItemClass}
        >
          <WalletMinimal className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left font-inter">
            {truncatedAddress}
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
