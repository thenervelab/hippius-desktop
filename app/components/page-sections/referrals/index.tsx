"use client";

import React, { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import CreateButton from "@/components/ui/button/CreateButton";
import {
  CornerBracket,
  CornerBracketUp,
  MousePointerClick,
  ReferralGrip,
  Tickets,
} from "@/components/ui/icons";

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

/* Referrals dashboard — ported from hippius-web. The desktop's
 * existing IPC-backed hooks (useReferralLinks, useUserReferrals)
 * return the same row shapes as web's chain queries, so the layout +
 * components port over unchanged.
 *
 * The page is intentionally only partially wired right now: the
 * Generate endpoint is the same `${API_CONFIG.baseUrl}/api/referrals/generate`
 * web hits, and the IS_DEV-only DevTools panel lets a developer seed
 * mock rows into both tables without touching the chain so layout
 * regressions can be caught even before referral codes exist. */

const IS_DEV = process.env.NODE_ENV === "development";

/* Seed values used to fill the sparkline buckets on each stat card —
 * same constants web uses so the two clients render an identical demo
 * chart while the live referral-analytics API is still under
 * development. */
const PLACEHOLDER_CHART = [
  2, 5, 3, 8, 4, 6, 1, 9, 3, 7, 2, 10, 5, 8, 3, 6, 4, 7, 2, 11, 5, 8, 4, 6,
  3, 9, 7, 12, 5, 8,
];

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

  /* Portal targets for the two per-table headers — same pattern the
   * Bridge tab uses to inject MiniPaginationControl into the parent
   * header. */
  const [linksControlsContainer, setLinksControlsContainer] =
    useState<HTMLDivElement | null>(null);
  const [historyControlsContainer, setHistoryControlsContainer] =
    useState<HTMLDivElement | null>(null);

  return (
    <DashboardTitleWrapper mainText="Referrals">
      <div className="w-full font-geist">
        {/* Header: Your Earnings + Referral Link + Share + Refresh */}
        <ReferralLinkHeader
          referralUrl={referralUrl}
          onRefresh={handleRefresh}
          isRefreshing={refreshing}
        />

        {/* Stat Cards Row */}
        <div className="relative overflow-visible border-b border-grey-dark-100 shadow-[0px_1px_0px_0px_white] dark:border-black-900 dark:shadow-[0px_1px_0px_0px_rgba(255,255,255,0.06)]">
          <div className="relative grid grid-cols-1 xl:grid-cols-3">
            <ReferralStatCard
              icon={
                <ReferralGrip className="size-4 text-primary-50 dark:text-primary-brand-dark" />
              }
              label="Total Referrals"
              value={totalReferrals}
              unit="Referrals"
              chartData={PLACEHOLDER_CHART}
              isLoading={isLoading}
            />
            <ReferralStatCard
              icon={
                <MousePointerClick className="size-4 text-primary-50 dark:text-primary-brand-dark" />
              }
              label="Total Usage"
              value={referralData?.referralHistory?.length ?? 0}
              unit=""
              chartData={PLACEHOLDER_CHART.map((v) => v * 2)}
              isLoading={isLoading}
            />
            <ReferralStatCard
              icon={
                <Tickets className="size-4 text-primary-50 dark:text-primary-brand-dark" />
              }
              label="Total hAlpha Earned"
              value={totalCredits}
              unit="hAlpha"
              chartData={PLACEHOLDER_CHART.map((v) => v * 3)}
              isLoading={isLoading}
            />

            {/* Column divider plus icons overlay */}
            <div
              aria-hidden="true"
              className="pointer-events-none hidden xl:grid absolute inset-0 z-10 grid-cols-3"
            >
              <div className="relative">
                <div className="absolute bottom-[-4.5px] right-[-4.5px]">
                  <CornerBracketUp className="text-[#8A8A8A] dark:text-[#7d7d7d]" />
                </div>
              </div>
              <div className="relative">
                <div className="absolute bottom-[-4.5px] right-[-4.5px]">
                  <CornerBracketUp className="text-[#8A8A8A] dark:text-[#7d7d7d]" />
                </div>
              </div>
              <div />
            </div>
          </div>

          {/* Bottom-left section junction icon */}
          <div className="pointer-events-none absolute bottom-0 left-0 z-10 translate-y-1/2 hidden sm:block">
            <CornerBracket className="text-[#8A8A8A] dark:text-[#7d7d7d]" />
          </div>
        </div>

        {/* Your Referral Links — 22px gap from stat cards */}
        <div className="relative mt-[22px] border-b border-grey-dark-100 shadow-[0px_1px_0px_0px_white] dark:border-black-900 dark:shadow-[0px_1px_0px_0px_rgba(255,255,255,0.06)]">
          <div className="flex flex-col px-3 sm:px-5 py-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[16px] sm:text-[18px] font-medium text-[#0a0a0a] dark:text-grey-light-100">
                Your Referral Links
              </h3>
              <div className="flex items-center gap-3">
                <div
                  ref={setLinksControlsContainer}
                  className="hidden sm:flex flex-wrap items-center gap-3 overflow-x-auto empty:hidden shrink-0"
                />
                <CreateButton
                  text="+ Generate"
                  isLoading={generating}
                  onClick={handleGenerateReferral}
                />
              </div>
            </div>
            <div className="mt-4">
              <ReferralLinksTable
                headerPortalTarget={linksControlsContainer}
                devData={devLinks ?? undefined}
                onGenerate={handleGenerateReferral}
                isGenerating={generating}
                isRefreshing={refreshing}
              />
            </div>
          </div>
        </div>

        {/* Referral History */}
        <div className="flex flex-col px-3 sm:px-5 py-3 pb-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[16px] sm:text-[18px] font-medium text-[#0a0a0a] dark:text-grey-light-100">
              Referral History
            </h3>
            <div
              ref={setHistoryControlsContainer}
              className="hidden sm:flex flex-wrap items-center gap-3 overflow-x-auto empty:hidden shrink-0"
            />
          </div>
          <div className="mt-4">
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
