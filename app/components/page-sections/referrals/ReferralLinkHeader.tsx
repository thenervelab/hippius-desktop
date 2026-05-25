"use client";

import React, { useCallback, useMemo } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";

import {
  CornerBracket,
  CornerBracketDown,
  Discord,
  InfoCircle,
  Link as LinkIcon,
  PlusCrossIcon,
  RefreshCcwDot,
  X,
} from "@/components/ui/icons";
import CustomTooltip from "@/components/ui/CustomTooltip";
import { cn } from "@/lib/utils";

import { useReferralLinks } from "@/lib/hooks/api/useReferralLinks";
import { REFERRAL_CODE_CONFIG } from "@/lib/config";

/* "Your Earnings" + share-and-copy strip at the top of the referrals
 * page. Ported from hippius-web — XL+ shows a 3-column layout with the
 * referral URL inline; below XL it stacks. */

const TelegramIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
  </svg>
);

const ReferralLinkHeader: React.FC<{
  referralUrl?: string | null;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}> = ({ referralUrl: referralUrlProp, onRefresh, isRefreshing = false }) => {
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

  const handleShareX = useCallback(() => {
    if (!referralUrl) return;
    const text = encodeURIComponent(
      `🚀 I'm using @hippius_subnet for decentralized storage, compute & more!\n\nJoin using my referral link and we both earn credits:\n${referralUrl}\n\n#Hippius #Web3 #Decentralized`,
    );
    window.open(`https://x.com/intent/tweet?text=${text}`, "_blank");
  }, [referralUrl]);

  const handleShareTelegram = useCallback(() => {
    if (!referralUrl) return;
    const url = encodeURIComponent(referralUrl);
    const text = encodeURIComponent(
      "🚀 I'm using Hippius for decentralized storage, compute & more! Join using my referral link and we both earn credits:",
    );
    window.open(`https://t.me/share/url?url=${url}&text=${text}`, "_blank");
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

  const iconButtonBase =
    "inline-flex items-center justify-center rounded-lg border border-[#e3e3e3] bg-white size-9 cursor-pointer transition-colors hover:bg-grey-light-400 dark:border-[#313131] dark:bg-[rgba(255,255,255,0.02)] dark:hover:bg-[rgba(255,255,255,0.05)] disabled:opacity-50 disabled:cursor-not-allowed";

  const tooltipNode = (
    <span className="block max-w-[240px] text-xs leading-[16px] text-grey-40">
      Credits are paid automatically on every purchase made through your
      referral link.
    </span>
  );

  const shareIcons = (
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        onClick={handleShareX}
        disabled={!referralUrl}
        className={iconButtonBase}
        title="Share on X"
      >
        <X className="size-4 text-[#0a0a0a] dark:text-[#bbb]" />
      </button>
      <button
        onClick={handleShareTelegram}
        disabled={!referralUrl}
        className={iconButtonBase}
        title="Share on Telegram"
      >
        <TelegramIcon className="size-4 text-[#0a0a0a] dark:text-[#bbb]" />
      </button>
      <button
        onClick={handleShareDiscord}
        disabled={!referralUrl}
        className={iconButtonBase}
        title="Share on Discord"
      >
        <Discord className="size-4 text-[#0a0a0a] dark:text-[#bbb]" />
      </button>
      <button
        onClick={handleRefresh}
        disabled={isRefreshing}
        className={iconButtonBase}
        title="Refresh"
      >
        <RefreshCcwDot
          className={cn(
            "size-4 text-[#0a0a0a] dark:text-[#bbb]",
            isRefreshing && "animate-spin",
          )}
        />
      </button>
    </div>
  );

  return (
    <div className="relative w-full font-geist border-b border-grey-dark-100 shadow-[0px_1px_0px_0px_white] dark:border-black-900 dark:shadow-[0px_1px_0px_0px_rgba(255,255,255,0.06)]">
      {/* ── Desktop 3-column grid (xl+, ≥1280px) ── */}
      <div className="hidden xl:grid xl:grid-cols-3">
        {/* Col 1: Title & subtitle */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-3 px-3 sm:px-5 xl:border-r border-grey-dark-100 dark:border-black-900">
          <div className="flex items-center gap-3">
            <h2 className="truncate font-geist text-[16px] font-medium leading-8 tracking-[-0.56px] text-[#0a0a0a] dark:text-grey-light-100 sm:text-[21px]">
              Your Earnings
            </h2>
            <CustomTooltip tooltip={tooltipNode} className="align-middle">
              <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-[5.455px] border-[0.909px] border-grey-dark-100 bg-grey-light-700 shadow-[0px_0.909px_0px_0px_white,inset_0px_1.818px_0px_0px_white] dark:border-[#494949] dark:bg-black-300/70 dark:shadow-none">
                <InfoCircle className="size-4 text-grey-50 opacity-40 dark:text-grey-light-100" />
              </span>
            </CustomTooltip>
          </div>
          <p className="text-base font-medium leading-[22px] tracking-[-0.32px] text-grey-60 dark:text-grey-dark-800">
            Earn 5% of every purchase your referrals make, for life.
          </p>
        </div>

        {/* Col 2–3: Referral link */}
        <div className="relative xl:col-span-2 flex items-center justify-between gap-3 px-5 py-3">
          {/* Column junction corner icons */}
          <div className="pointer-events-none absolute left-0 -top-[4.5px] z-10 -translate-x-1/2">
            <PlusCrossIcon className="text-[#8A8A8A] dark:text-[#7d7d7d]" />
          </div>
          <div className="pointer-events-none absolute left-0 bottom-[-4.5px] z-10 -translate-x-1/2">
            <PlusCrossIcon className="text-[#8A8A8A] dark:text-[#7d7d7d]" />
          </div>
          <div className="pointer-events-none absolute left-1/2 bottom-[-4.5px] z-10 -translate-x-1/2">
            <CornerBracketDown className="text-[#8A8A8A] dark:text-[#7d7d7d]" />
          </div>

          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <LinkIcon className="size-4 text-primary-50" />
              <span className="font-geist-mono text-[12px] font-medium uppercase tracking-[-0.24px] text-primary-50 dark:text-primary-brand-dark">
                Referral Link
              </span>
            </div>
            <span className="text-xs text-grey-dark-800 dark:text-grey-dark-800">
              Copy and share your link.
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              disabled={!referralUrl}
              className="flex items-center gap-2 rounded-lg border border-[#e3e3e3] bg-white px-4 py-2 text-sm cursor-pointer transition-colors hover:bg-grey-light-400 dark:border-[#313131] dark:bg-[rgba(255,255,255,0.02)] dark:hover:bg-[rgba(255,255,255,0.05)] disabled:opacity-50 disabled:cursor-not-allowed max-w-[340px]"
            >
              <span className="font-mono text-sm text-[#0a0a0a] dark:text-[#bbb] truncate">
                {displayUrl}
              </span>
              <Copy className="size-4 shrink-0 text-[#0a0a0a] opacity-60 dark:text-[#bbb]" />
            </button>
            {shareIcons}
          </div>
        </div>
      </div>

      {/* ── Compact layout (< xl, covers mobile + all tablets) ── */}
      <div className="xl:hidden">
        <div className="flex min-w-0 flex-col gap-0.5 px-3 sm:px-5 py-3 border-b border-grey-dark-100 dark:border-black-900">
          <div className="flex items-center gap-3">
            <h2 className="truncate font-geist text-[16px] font-medium leading-8 tracking-[-0.56px] text-[#0a0a0a] dark:text-grey-light-100 sm:text-[18px]">
              Your Earnings
            </h2>
            <CustomTooltip tooltip={tooltipNode} className="align-middle">
              <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-[5.455px] border-[0.909px] border-grey-dark-100 bg-grey-light-700 shadow-[0px_0.909px_0px_0px_white,inset_0px_1.818px_0px_0px_white] dark:border-[#494949] dark:bg-black-300/70 dark:shadow-none">
                <InfoCircle className="size-4 text-grey-50 opacity-40 dark:text-grey-light-100" />
              </span>
            </CustomTooltip>
          </div>
          <p className="hidden sm:block text-base font-medium leading-[22px] tracking-[-0.32px] text-grey-60 dark:text-grey-dark-800">
            Earn 5% of every purchase your referrals make, for life.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-5 py-3">
          <div className="flex items-center gap-1.5 shrink-0">
            <LinkIcon className="size-4 text-primary-50" />
            <span className="font-geist-mono text-[12px] font-medium uppercase tracking-[-0.24px] text-primary-50 dark:text-primary-brand-dark">
              Referral Link
            </span>
          </div>
          <button
            onClick={handleCopy}
            disabled={!referralUrl}
            className="flex min-w-[160px] flex-1 items-center gap-2 rounded-lg border border-[#e3e3e3] bg-white px-4 py-2 text-sm cursor-pointer transition-colors hover:bg-grey-light-400 dark:border-[#313131] dark:bg-[rgba(255,255,255,0.02)] dark:hover:bg-[rgba(255,255,255,0.05)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="min-w-0 flex-1 truncate text-left font-mono text-sm text-[#0a0a0a] dark:text-[#bbb]">
              {displayUrl}
            </span>
            <Copy className="size-4 shrink-0 text-[#0a0a0a] opacity-60 dark:text-[#bbb]" />
          </button>
          <div className="ml-auto">{shareIcons}</div>
        </div>
      </div>

      {/* Bottom-left section junction icon — desktop only */}
      <div className="pointer-events-none absolute bottom-0 left-0 z-10 translate-y-1/2 hidden xl:block">
        <CornerBracket className="text-[#8A8A8A] dark:text-[#7d7d7d]" />
      </div>
    </div>
  );
};

export default ReferralLinkHeader;
