"use client";

import React, { useCallback, useMemo } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  Discord,
  Link as LinkIcon,
  RefreshCcwDot,
  X,
} from "@/components/ui/icons";
import { cn } from "@/lib/utils";

import { useReferralLinks } from "@/lib/hooks/api/useReferralLinks";
import { REFERRAL_CODE_CONFIG } from "@/lib/config";

/* Compact referral-link block used as the rightSlot of the page-level
 * PageHeader. The previous 3-column layout with PlusCrossIcon /
 * CornerBracket overlays was a holdover from the hippius-web port; the
 * desktop's PageHeader already provides the title + subtitle column,
 * so we drop the duplicated heading and the corner-junction icons. */

const TelegramIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
  </svg>
);

interface ReferralLinkHeaderProps {
  referralUrl?: string | null;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

const ReferralLinkHeader: React.FC<ReferralLinkHeaderProps> = ({
  referralUrl: referralUrlProp,
  onRefresh,
  isRefreshing = false,
}) => {
  const { links, reload } = useReferralLinks();

  const mostRecentLink = useMemo(() => {
    if (!links || links.length === 0) return null;
    return links[links.length - 1];
  }, [links]);

  const referralUrl =
    referralUrlProp ??
    (mostRecentLink
      ? `${REFERRAL_CODE_CONFIG.link}${mostRecentLink.code}`
      : null);

  const displayUrl = referralUrl ?? "No referral link yet";

  const handleCopy = useCallback(() => {
    if (!referralUrl) return;
    navigator.clipboard.writeText(referralUrl);
    toast.success("Referral link copied to clipboard!");
  }, [referralUrl]);

  // External URLs must be opened via Tauri's opener plugin —
  // `window.open()` is a no-op in a Tauri webview because the runtime
  // intercepts navigation requests it can't route. Other pages
  // (CreditsWidget, etc.) use the same plugin via `openLinkByKey`.
  const handleShareX = useCallback(async () => {
    if (!referralUrl) return;
    const text = encodeURIComponent(
      `🚀 I'm using @hippius_subnet for decentralized storage, compute & more!\n\nJoin using my referral link and we both earn credits:\n${referralUrl}\n\n#Hippius #Web3 #Decentralized`,
    );
    try {
      await openUrl(`https://x.com/intent/tweet?text=${text}`);
    } catch {
      toast.error("Failed to open X. Please try again.");
    }
  }, [referralUrl]);

  const handleShareTelegram = useCallback(async () => {
    if (!referralUrl) return;
    const url = encodeURIComponent(referralUrl);
    const text = encodeURIComponent(
      "🚀 I'm using Hippius for decentralized storage, compute & more! Join using my referral link and we both earn credits:",
    );
    try {
      await openUrl(`https://t.me/share/url?url=${url}&text=${text}`);
    } catch {
      toast.error("Failed to open Telegram. Please try again.");
    }
  }, [referralUrl]);

  const handleShareDiscord = useCallback(async () => {
    if (!referralUrl) return;
    const shareText = `🚀 Check out Hippius — decentralized storage, compute & more!\n\nJoin using my referral link and we both earn credits:\n${referralUrl}`;
    try {
      await navigator.clipboard.writeText(shareText);
      toast.success(
        "Referral message copied! Paste it in any Discord channel.",
      );
    } catch {
      toast.error("Failed to copy to clipboard.");
    }
  }, [referralUrl]);

  const handleRefresh = useCallback(() => {
    if (onRefresh) {
      onRefresh();
    } else if (reload) {
      reload();
    }
    toast.success("Refreshing referral data…");
  }, [onRefresh, reload]);

  // Tile dimensions, border, fill and inset highlight per the Figma
  // share-icon spec. Light mode gets the double-inset white shadow
  // (top-inner + 1px below) that gives the tile its embossed look;
  // dark mode drops the shadow entirely since the dark fill swallows it.
  const iconButtonBase =
    "inline-flex shrink-0 items-center justify-center gap-1 w-[39px] h-[37px] px-2 py-1.5 rounded-md cursor-pointer transition-colors border border-[#E3E3E3] bg-[#F2F2F2] shadow-[inset_0_2px_0_0_#FFF,0_1px_0_0_#FFF] hover:bg-[#E8E8E8] dark:border-[#313131] dark:bg-[#161616] dark:shadow-none dark:hover:bg-[#1F1F1F] disabled:opacity-50 disabled:cursor-not-allowed";
  const iconClass = "size-4 text-[#0a0a0a] dark:text-[#bbb]";

  return (
    <div
      className={cn(
        "flex items-stretch overflow-hidden rounded-[8px] border",
        "border-grey-light-500 bg-grey-light-600",
        "dark:border-black-300 dark:bg-black-primary-bg",
      )}
    >
      {/* Label + subtitle column */}
      <div className="flex flex-col items-start justify-center gap-[2px] border-r border-grey-dark-100 dark:border-black-500 px-3.5 py-2 shrink-0">
        <div className="flex items-center gap-1">
          <LinkIcon className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
          <span className="font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
            Referral Link
          </span>
        </div>
        <span className="text-[11px] leading-[14px] text-grey-dark-800 dark:text-grey-dark-600 whitespace-nowrap">
          Copy and share your link.
        </span>
      </div>

      {/* URL chip + share icons */}
      <div className="flex flex-1 min-w-0 items-center gap-1.5 px-3 py-2">
        <button
          onClick={handleCopy}
          disabled={!referralUrl}
          className="flex w-[227px] shrink-0 items-center gap-2 rounded-lg border border-[#e3e3e3] bg-white px-3 py-1.5 cursor-pointer transition-colors hover:bg-grey-light-400 dark:border-[#313131] dark:bg-[rgba(255,255,255,0.02)] dark:hover:bg-[rgba(255,255,255,0.05)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className="min-w-0 flex-1 truncate text-left font-mono text-[13px] text-[#0a0a0a] dark:text-[#bbb]">
            {displayUrl}
          </span>
          <Copy className="size-4 shrink-0 text-[#0a0a0a] opacity-60 dark:text-[#bbb]" />
        </button>

        <button
          onClick={handleShareX}
          disabled={!referralUrl}
          className={iconButtonBase}
          title="Share on X"
        >
          <X className={iconClass} />
        </button>
        <button
          onClick={handleShareTelegram}
          disabled={!referralUrl}
          className={iconButtonBase}
          title="Share on Telegram"
        >
          <TelegramIcon className={iconClass} />
        </button>
        <button
          onClick={handleShareDiscord}
          disabled={!referralUrl}
          className={iconButtonBase}
          title="Share on Discord"
        >
          <Discord className={iconClass} />
        </button>
        <span
          aria-hidden="true"
          className="mx-1 h-5 w-px shrink-0 bg-[#e3e3e3] dark:bg-[#313131]"
        />
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className={iconButtonBase}
          title="Refresh"
        >
          <RefreshCcwDot
            className={cn(iconClass, isRefreshing && "animate-spin")}
          />
        </button>
      </div>
    </div>
  );
};

export default ReferralLinkHeader;
