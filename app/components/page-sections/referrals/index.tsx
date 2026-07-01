"use client";

import React, { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import PageHeader from "@/components/page-sections/home/PageHeader";
import CreateButton from "@/components/ui/button/CreateButton";
import ComingSoon from "@/components/ui/ComingSoon";
import { REFERRALS_COMING_SOON } from "@/app/lib/featureFlags";
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

import { useReferralLinks } from "@/lib/hooks/api/useReferralLinks";
import { useUserReferrals } from "@/lib/hooks/api/useUserReferrals";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { REFERRAL_CODE_CONFIG } from "@/lib/config";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "@/lib/utils/errorUtils";

/* Referrals dashboard — restyled to match the desktop card pattern used
 * across the wallet, billing and settings pages: rounded shell + mono
 * uppercase header strip + inner white panel. The corner-junction
 * overlay icons (CornerBracket / PlusCrossIcon) that came over from
 * the hippius-web port are removed — the desktop layout uses bordered
 * cards instead of edge-to-edge sections, so the junction markers have
 * nothing to anchor against. */

/**
 * When `true`, the entire referrals page renders behind a blurred
 * "Coming Soon" overlay — the sidebar link still routes here, the
 * page still mounts (so the FE doesn't have to invalidate route
 * navigation), but the content is visibly gated. The flag lives in the
 * shared featureFlags module (imported above) so release gating is
 * edited in one place.
 */

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
      // Goes through Rust IPC (audit M-17) instead of a renderer fetch, so the
      // referral action crosses the same boundary as every other domain call.
      await invoke("generate_referral_link", { address: polkadotAddress });
      toast.success("Referral Code Generated Successfully!");
      reloadLinks?.();
      refetchReferrals();
    } catch (err) {
      console.error("Generate referral failed:", err);
      toast.error(errorMessage(err));
    } finally {
      setGenerating(false);
    }
  }, [polkadotAddress, reloadLinks, refetchReferrals]);

  const totalReferrals = referralData?.totalReferrals ?? 0;
  const totalCredits = links.reduce(
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
      {/* `relative` so the absolute-positioned coming-soon overlay
       *  hangs off this container instead of the dashboard chrome
       *  around it. The page itself stays interactive (no
       *  `pointer-events-none` on the wrapper) — the dot grid + corner
       *  badge communicate "not ready" visually without disabling
       *  every cell. */}
      <div className="relative flex flex-col px-4 pb-6">
        {REFERRALS_COMING_SOON && (
          <ComingSoon
            variant="white"
            overlay
            blurIntensity="extraLight"
            position="top-right"
            size="small"
          />
        )}
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
              isRefreshing={refreshing}
            />
          </div>
        </div>
      </div>
    </DashboardTitleWrapper>
  );
};

export default Referrals;
