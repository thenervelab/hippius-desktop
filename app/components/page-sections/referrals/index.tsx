"use client";

import React, { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import PageHeader from "@/components/page-sections/home/PageHeader";
import CreateButton from "@/components/ui/button/CreateButton";
import {
  Clock,
  Link as LinkIcon,
  MousePointerClick,
  ReferralGrip,
  Tickets,
} from "@/components/ui/icons";
import { cn } from "@/lib/utils";

import ReferralLinkHeader from "./ReferralLinkHeader";
import ReferralStatCard from "./ReferralStatCard";
import ReferralLinksTable from "./ReferralLinksTable";
import ReferralHistoryTable from "./ReferralHistoryTable";

import {
  useReferralLinks,
  type ReferralLink,
} from "@/lib/hooks/api/useReferralLinks";
import {
  useUserReferrals,
  type ReferralEvent,
} from "@/lib/hooks/api/useUserReferrals";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { API_CONFIG, REFERRAL_CODE_CONFIG } from "@/lib/config";

/* Referrals dashboard — restyled to match the desktop card pattern used
 * across the wallet, billing and settings pages: rounded shell + mono
 * uppercase header strip + inner white panel. The corner-junction
 * overlay icons (CornerBracket / PlusCrossIcon) that came over from
 * the hippius-web port are removed — the desktop layout uses bordered
 * cards instead of edge-to-edge sections, so the junction markers have
 * nothing to anchor against. */

const IS_DEV = process.env.NODE_ENV === "development";

/* Seed values used to fill the sparkline buckets on each stat card —
 * same constants web uses so the two clients render an identical demo
 * chart while the live referral-analytics API is still under
 * development. */
const PLACEHOLDER_CHART = [
  2, 5, 3, 8, 4, 6, 1, 9, 3, 7, 2, 10, 5, 8, 3, 6, 4, 7, 2, 11, 5, 8, 4, 6,
  3, 9, 7, 12, 5, 8,
];

/* Shared shell classes for the two table sections. Same palette as the
 * "Billing History" wrapper on the billing page and the "Tabbed table
 * surface" on the wallet page. */
const SECTION_SHELL_CLASS = cn(
  "mt-6 flex flex-col items-center w-full rounded-[8px] border overflow-hidden",
  "bg-grey-light-300 border-grey-dark-100",
  "dark:bg-black-primary-bg dark:border-black-300",
  "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
);

const SECTION_HEADER_CLASS =
  "flex h-[46px] w-full items-center justify-between gap-2 pl-[14px] pr-[10px]";

const SECTION_BODY_CLASS = cn(
  "flex flex-col w-full flex-1",
  "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
  "bg-white dark:bg-black-600 dark:border-black-300",
  "overflow-hidden",
);

const SECTION_HEADER_LABEL_CLASS =
  "font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase";

/* ── Dev mock data generators ───────────────────────────────────── */

function generateMockLinks(count: number): ReferralLink[] {
  return Array.from({ length: count }, (_, i) => ({
    code: `REF${String(i + 1).padStart(3, "0")}${Math.random().toString(36).slice(2, 8)}`,
    reward: String(Math.floor(Math.random() * 500) + 10),
  }));
}

function generateMockHistory(count: number): ReferralEvent[] {
  return Array.from({ length: count }, () => {
    const daysAgo = Math.floor(Math.random() * 90);
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return {
      address: `5${Math.random().toString(36).slice(2, 10)}${Math.random()
        .toString(36)
        .slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 48),
      date: d.toISOString().split("T")[0],
      status: "Active" as const,
      reward: String(Math.floor(Math.random() * 200) + 5),
    };
  });
}

/* ── Dev Tools floating panel (development builds only) ────────── */

function DevToolsPanel({
  onApply,
  onClear,
  hasData,
}: {
  onApply: (linkCount: number, historyCount: number) => void;
  onClear: () => void;
  hasData: boolean;
}) {
  const [linkCount, setLinkCount] = useState(5);
  const [historyCount, setHistoryCount] = useState(12);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-[9999] flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-white shadow-lg hover:bg-amber-600 transition-colors"
      >
        <svg
          className="size-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        Dev Tools
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-[9999] w-72 rounded-xl border border-amber-300 bg-white p-4 shadow-2xl dark:border-amber-700 dark:bg-[#1a1a1a]">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-bold text-amber-600 dark:text-amber-400">
          Referral Dev Tools
        </h4>
        <button
          onClick={() => setOpen(false)}
          className="text-grey-50 hover:text-grey-10 dark:hover:text-white transition-colors"
        >
          <svg
            className="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-[11px] font-medium text-grey-50 dark:text-grey-dark-800 mb-1">
            Referral Links ({linkCount})
          </label>
          <input
            type="range"
            min={0}
            max={50}
            value={linkCount}
            onChange={(e) => setLinkCount(Number(e.target.value))}
            className="w-full accent-amber-500"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-grey-50 dark:text-grey-dark-800 mb-1">
            History Rows ({historyCount})
          </label>
          <input
            type="range"
            min={0}
            max={50}
            value={historyCount}
            onChange={(e) => setHistoryCount(Number(e.target.value))}
            className="w-full accent-amber-500"
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onApply(linkCount, historyCount)}
            className="flex-1 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 transition-colors"
          >
            Generate Data
          </button>
          <button
            onClick={onClear}
            disabled={!hasData}
            className="flex-1 rounded-lg border border-grey-dark-100 px-3 py-1.5 text-xs font-semibold text-grey-10 dark:text-grey-light-100 dark:border-[#444] hover:bg-grey-light-400 dark:hover:bg-[rgba(255,255,255,0.05)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Main page ─────────────────────────────────────────────────── */

const Referrals: React.FC = () => {
  const { links, loading: linksLoading, reload: reloadLinks } =
    useReferralLinks();
  const {
    data: referralData,
    isPending: referralsPending,
    refetch: refetchReferrals,
  } = useUserReferrals();

  const { polkadotAddress } = useWalletAuth();
  const [generating, setGenerating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  /* Build the canonical referral URL: prefer useReferralLinks data,
   * fall back to useUserReferrals' code list. */
  const referralUrl = useMemo(() => {
    if (links.length > 0) {
      return `${REFERRAL_CODE_CONFIG.link}${links[links.length - 1].code}`;
    }
    if (
      referralData?.referralCodes &&
      referralData.referralCodes.length > 0
    ) {
      const lastCode =
        referralData.referralCodes[referralData.referralCodes.length - 1];
      return `${REFERRAL_CODE_CONFIG.link}${lastCode}`;
    }
    return null;
  }, [links, referralData?.referralCodes]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([reloadLinks?.(), refetchReferrals()]);
    } finally {
      setRefreshing(false);
    }
  }, [reloadLinks, refetchReferrals]);

  const handleGenerateReferral = useCallback(async () => {
    if (!polkadotAddress) {
      toast.error("Please log in to generate a referral link.");
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch(`${API_CONFIG.baseUrl}/api/referrals/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: polkadotAddress }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.message || `Request failed (${res.status})`);
      }
      toast.success("Referral Code Generated Successfully!");
      reloadLinks?.();
      refetchReferrals();
    } catch (err) {
      console.error("Generate referral failed:", err);
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to generate referral code.",
      );
    } finally {
      setGenerating(false);
    }
  }, [polkadotAddress, reloadLinks, refetchReferrals]);

  /* Dev-tools overrides — surfaced only in development builds. */
  const [devLinks, setDevLinks] = useState<ReferralLink[] | null>(null);
  const [devHistory, setDevHistory] = useState<ReferralEvent[] | null>(null);

  const handleDevApply = useCallback(
    (linkCount: number, historyCount: number) => {
      setDevLinks(generateMockLinks(linkCount));
      setDevHistory(generateMockHistory(historyCount));
    },
    [],
  );

  const handleDevClear = useCallback(() => {
    setDevLinks(null);
    setDevHistory(null);
  }, []);

  const effectiveLinks = devLinks ?? links;
  const totalReferrals = devHistory
    ? devHistory.length
    : referralData?.totalReferrals ?? 0;
  const totalCredits = effectiveLinks.reduce(
    (sum, { reward }) => sum + Number(reward),
    0,
  );
  const isLoading = linksLoading || referralsPending || refreshing;

  /* Portal targets for each table's MiniPaginationControl — injected
   * into the section header by the child via createPortal. Same pattern
   * the wallet bridge tab uses. */
  const [linksControlsContainer, setLinksControlsContainer] =
    useState<HTMLDivElement | null>(null);
  const [historyControlsContainer, setHistoryControlsContainer] =
    useState<HTMLDivElement | null>(null);

  return (
    <DashboardTitleWrapper mainText="Referrals">
      <div className="flex flex-col px-4 pb-6">
        <PageHeader
          title="Referrals"
          subtitle="Earn 5% of every purchase your referrals make, for life."
          showTopUpCredits={false}
          rightSlot={
            <ReferralLinkHeader
              referralUrl={referralUrl}
              onRefresh={handleRefresh}
              isRefreshing={refreshing}
            />
          }
          infoButton={
            <TooltipPrimitive.Provider delayDuration={300}>
              <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>
                  <button
                    type="button"
                    aria-label="Referrals information"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-grey-80 bg-white text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-400"
                  >
                    <Info className="size-3.5" />
                  </button>
                </TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                  <TooltipPrimitive.Content
                    side="bottom"
                    align="center"
                    sideOffset={8}
                    avoidCollisions
                    collisionPadding={8}
                    className="z-[9999] max-w-[280px] rounded-[8px] border border-grey-dark-100 bg-white px-3 py-[10px] text-[12px] font-medium leading-4 tracking-[-0.24px] text-[#52525c] shadow-[0px_4px_24px_0px_rgba(0,0,0,0.08)] dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-[#a3a3a3] dark:shadow-black/25"
                  >
                    Credits are paid automatically on every purchase made
                    through your referral link.
                    <TooltipPrimitive.Arrow className="fill-white dark:fill-[#2c2c2c]" />
                  </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
              </TooltipPrimitive.Root>
            </TooltipPrimitive.Provider>
          }
        />

        {/* Top 3-card stat grid */}
        <div className="mt-4 grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3 gap-4">
          <ReferralStatCard
            icon={<ReferralGrip />}
            label="Total Referrals"
            value={totalReferrals}
            unit="Referrals"
            chartData={PLACEHOLDER_CHART}
            isLoading={isLoading}
          />
          <ReferralStatCard
            icon={<MousePointerClick />}
            label="Total Usage"
            value={referralData?.referralHistory?.length ?? 0}
            unit=""
            chartData={PLACEHOLDER_CHART.map((v) => v * 2)}
            isLoading={isLoading}
          />
          <ReferralStatCard
            icon={<Tickets />}
            label="Total hAlpha Earned"
            value={totalCredits}
            unit="hAlpha"
            chartData={PLACEHOLDER_CHART.map((v) => v * 3)}
            isLoading={isLoading}
          />
        </div>

        {/* Referral Links section */}
        <div className={SECTION_SHELL_CLASS}>
          <div className={SECTION_HEADER_CLASS}>
            <div className="flex items-center gap-1 min-w-0">
              <LinkIcon className="size-[14px] shrink-0 text-primary-40 dark:text-primary-brand-dark" />
              <p className={cn(SECTION_HEADER_LABEL_CLASS, "truncate")}>
                Referral Links
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div
                ref={setLinksControlsContainer}
                className="flex flex-wrap items-center gap-3 overflow-x-auto empty:hidden"
              />
              <CreateButton
                text="+ Generate"
                isLoading={generating}
                onClick={handleGenerateReferral}
              />
            </div>
          </div>
          <div className={SECTION_BODY_CLASS}>
            <ReferralLinksTable
              headerPortalTarget={linksControlsContainer}
              devData={devLinks ?? undefined}
              onGenerate={handleGenerateReferral}
              isGenerating={generating}
              isRefreshing={refreshing}
            />
          </div>
        </div>

        {/* Referral History section */}
        <div className={SECTION_SHELL_CLASS}>
          <div className={SECTION_HEADER_CLASS}>
            <div className="flex items-center gap-1 min-w-0">
              <Clock className="size-[14px] shrink-0 text-primary-40 dark:text-primary-brand-dark" />
              <p className={cn(SECTION_HEADER_LABEL_CLASS, "truncate")}>
                Referral History
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div
                ref={setHistoryControlsContainer}
                className="flex flex-wrap items-center gap-3 overflow-x-auto empty:hidden"
              />
            </div>
          </div>
          <div className={SECTION_BODY_CLASS}>
            <ReferralHistoryTable
              headerPortalTarget={historyControlsContainer}
              devData={devHistory ?? undefined}
              isRefreshing={refreshing}
            />
          </div>
        </div>

        {/* Dev tools — only rendered in development builds */}
        {IS_DEV && (
          <DevToolsPanel
            onApply={handleDevApply}
            onClear={handleDevClear}
            hasData={devLinks !== null || devHistory !== null}
          />
        )}
      </div>
    </DashboardTitleWrapper>
  );
};

export default Referrals;
