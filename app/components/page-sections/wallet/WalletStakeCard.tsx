"use client";

import { FC, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  StakeIndicator,
  StakeNow,
  UnstakeHalpha,
  OutGoing,
} from "@/components/ui/icons";
import { Clock } from "lucide-react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useStaking } from "@/app/lib/hooks/useStaking";
import StakeDialog from "./StakeDialog";
import UnstakeDialog from "./UnstakeDialog";
import WithdrawDialog from "./WithdrawDialog";

interface WalletStakeCardProps {
  className?: string;
}

/**
 * Truncate (not round) to 4 decimals so the rendered value never reads
 * larger than the on-chain amount. Mirrors `formatCompactAmount` in
 * hippius-web's StakeWidget.
 */
const formatCompactAmount = (value: string): string => {
  const parsed = Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed)) return value;
  let result = (Math.floor(parsed * 10000) / 10000).toFixed(4);
  result = result.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return result;
};

/**
 * Convert remaining blocks to a "~Nd Nh" / "~Nh Nm" / "~Nm" string.
 * Exact copy of hippius-web's `formatRemainingTime` helper, including
 * the 6-second-per-block assumption (Hippius runs BABE at 6s slots).
 *
 * Desktop's Rust `get_staking_info` IPC currently only exposes
 * `remainingEras` per unbonding chunk, not `remainingBlocks`. Until the
 * Rust side surfaces `era_length` / `era_progress` (matching the data
 * web's `derive.session.progress` returns) we fall back to a
 * coarse-grained "~N era(s)" label inside this helper — the caller
 * decides which units it has and picks the right branch.
 */
const BLOCK_TIME_SECONDS = 6;
const formatRemainingFromBlocks = (blocks: number): string => {
  if (blocks <= 0) return "";
  const totalSeconds = blocks * BLOCK_TIME_SECONDS;
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};

const formatRemainingFromEras = (eras: number): string => {
  if (eras <= 0) return "";
  return `~${eras} era${eras === 1 ? "" : "s"}`;
};

const WalletStakeCard: FC<WalletStakeCardProps> = ({ className }) => {
  // `isLoading` fires whenever React Query has no cached data for the
  // current queryKey — and since `useStaking` now keys by the active
  // wallet's address, switching wallets to one we haven't visited yet
  // shows the skeleton until the new data lands. Using `isFetching`
  // instead would flicker the skeleton every 6s on each poll tick.
  const { stakingInfo, isLoading, refetch } = useStaking();

  const [stakeOpen, setStakeOpen] = useState(false);
  const [unstakeOpen, setUnstakeOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const bondedHip = stakingInfo?.bondedHip ?? "0";
  const unbondingHip = stakingInfo?.unbondingHip ?? "0";
  const withdrawableHip = stakingInfo?.withdrawableHip ?? "0";

  const hasBonded = Number.parseFloat(bondedHip) > 0;
  const hasUnbonding = Number.parseFloat(unbondingHip) > 0;
  const hasWithdrawable = Number.parseFloat(withdrawableHip) > 0;

  const displayBonded = formatCompactAmount(bondedHip);
  const displayUnbonding = formatCompactAmount(unbondingHip);
  const displayWithdrawable = formatCompactAmount(withdrawableHip);

  // Chunks are returned newest-first by Rust; the longest-remaining one
  // sets the at-a-glance clock label. Per-chunk detail lives in the
  // tooltip below.
  const unbondingPeriods = stakingInfo?.unbondingPeriods ?? [];
  const longestRemainingEras = unbondingPeriods.reduce(
    (max, p) => Math.max(max, p.remainingEras),
    0,
  );

  // When Rust surfaces `remainingBlocks` (chain-precise) we render the
  // same "Nd Nh" countdown hippius-web uses. If the runtime hasn't
  // returned that value for any chunk yet (older spec, RPC blip) we
  // fall back to a coarse "~N era(s)" label so the user still sees
  // *something* meaningful while the chain catches up.
  const totalRemainingBlocks = unbondingPeriods.reduce(
    (max, p) =>
      typeof p.remainingBlocks === "number"
        ? Math.max(max, p.remainingBlocks)
        : max,
    0,
  );
  const longestRemainingLabel =
    totalRemainingBlocks > 0
      ? formatRemainingFromBlocks(totalRemainingBlocks)
      : formatRemainingFromEras(longestRemainingEras);

  // Metric layout — Staked is always shown; Redeemable / Unstaking only
  // when non-zero. The user-facing rules:
  //   1 metric  → big number + "hAlpha" label (original look).
  //   2 metrics → both inline; first left, second right (justify-between).
  //   3 metrics → first two inline (left/right), third on a second row.
  // The 1-metric branch preserves the previous card layout exactly so a
  // brand-new account with nothing redeemable / unstaking reads the
  // same as before.
  const metricItems: Array<{
    key: "staked" | "redeemable" | "unstaking";
    value: string;
    shortLabel: string;
    longLabel: string;
  }> = [
    {
      key: "staked",
      value: isLoading ? "0" : displayBonded,
      shortLabel: "Staked",
      longLabel: "hAlpha",
    },
    ...(hasWithdrawable
      ? [
          {
            key: "redeemable" as const,
            value: displayWithdrawable,
            shortLabel: "Redeemable",
            longLabel: "Redeemable hALPHA",
          },
        ]
      : []),
    ...(hasUnbonding
      ? [
          {
            key: "unstaking" as const,
            value: displayUnbonding,
            shortLabel: "Unstaking",
            longLabel: "Unstaking hALPHA",
          },
        ]
      : []),
  ];

  const isSingleMetric = metricItems.length === 1;
  // Slice into rows: row 1 holds up to 2 items (left/right aligned),
  // row 2 holds the third when present.
  const firstRow = metricItems.slice(0, 2);
  const secondRow = metricItems.slice(2);

  const renderMetric = (item: (typeof metricItems)[number]) => (
    // `items-baseline` lines the label up with the value's text
    // baseline — matches how "hALPHA" sits on "1.299999" in the
    // MY BALANCE card. `items-end` (the previous default) aligned
    // the boxes' bottoms which left the small label visually higher
    // than the value's descender on the compact 20px font.
    <div key={item.key} className="flex items-baseline gap-1 min-w-0">
      <span
        className={cn(
          "font-mono font-medium tracking-[-0.96px] text-grey-10 dark:text-white",
          isSingleMetric
            ? "text-[24px] leading-[30px]"
            : "text-[20px] leading-[24px]",
        )}
      >
        {item.value}
      </span>
      <span
        className={cn(
          "font-mono font-medium tracking-[-0.48px]",
          isSingleMetric
            ? "text-[12px] leading-[18px] text-grey-10/50 dark:text-white/50"
            : "text-[10px] leading-[14px] text-grey-dark-800 dark:text-grey-dark-600",
        )}
      >
        {isSingleMetric ? item.longLabel : item.shortLabel}
      </span>
      {item.key === "unstaking" && hasUnbonding && (
        // Radix Tooltip portals the content to the body, so it escapes
        // the card's `overflow-hidden` chrome. The previous inline
        // absolute-positioned panel got clipped at the top edge of the
        // card whenever the tooltip wanted to render above the trigger.
        //
        // Trigger renders as a plain inline span (not inline-flex) so
        // the parent's `items-baseline` aligns by the actual text
        // baseline of "1d 22h" rather than a synthesised inline-flex
        // baseline. The clock icon uses `align-text-bottom` so it
        // anchors to the same descender line as the surrounding text,
        // putting the icon + time at exactly the same level as the
        // "Unstaking" label.
        <TooltipPrimitive.Provider delayDuration={150}>
          <TooltipPrimitive.Root>
            <TooltipPrimitive.Trigger asChild>
              <span
                className="text-[10px] font-medium leading-none tracking-[-0.24px] text-amber-500 cursor-pointer focus:outline-none"
                tabIndex={0}
              >
                <Clock className="inline-block size-3 align-text-bottom text-amber-500" />
                {longestRemainingLabel && (
                  <span className="ml-1">{longestRemainingLabel}</span>
                )}
              </span>
            </TooltipPrimitive.Trigger>
            <TooltipPrimitive.Portal>
              <TooltipPrimitive.Content
                side="top"
                align="end"
                sideOffset={6}
                collisionPadding={8}
                avoidCollisions
                className={cn(
                  "z-50 max-w-[300px] rounded-lg border px-3 py-2 text-xs shadow-md",
                  "border-[#e3e3e3] bg-white dark:border-[#494949] dark:bg-[#2a2a2a] dark:shadow-black/30",
                  "animate-in fade-in-0 zoom-in-95",
                )}
              >
                <div className="mb-1 font-semibold text-[#4f4f4f] dark:text-[#a0a0a0]">
                  Unbonding Details
                </div>
                {unbondingPeriods.map((p, i) => {
                  const remaining =
                    typeof p.remainingBlocks === "number" && p.remainingBlocks > 0
                      ? formatRemainingFromBlocks(p.remainingBlocks)
                      : formatRemainingFromEras(p.remainingEras);
                  return (
                    <div
                      key={i}
                      className="whitespace-nowrap leading-relaxed text-[#0a0a0a] dark:text-white"
                    >
                      {formatCompactAmount(p.amountHip)} hALPHA
                      <span className="ml-1 text-[#6c6c6c] dark:text-[#8a8a8a]">
                        {remaining
                          ? `~${remaining} remaining`
                          : "ready to withdraw"}
                      </span>
                    </div>
                  );
                })}
              </TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
          </TooltipPrimitive.Root>
        </TooltipPrimitive.Provider>
      )}
    </div>
  );

  return (
    <>
      <div
        className={cn(
          "flex flex-col items-center w-full h-[205px] rounded-[8px] border overflow-hidden",
          "bg-grey-light-300 border-grey-dark-100",
          "dark:bg-black-primary-bg dark:border-black-300",
          "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
          className,
        )}
      >
        {/* Header — title left, Withdraw button (when redeemable) right.
            Stake Now / Unstake hAlpha stay at the bottom of the body so
            the primary CTAs read consistently regardless of whether the
            user has anything to withdraw. */}
        <div className="flex min-h-[38px] w-full items-center justify-between gap-2 pl-[14px] pr-[10px]">
          <div className="flex items-center gap-1 shrink-0">
            <StakeIndicator className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
            <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
              Stake hALPHA
            </p>
          </div>
          {hasWithdrawable && (
            <Button
              type="button"
              variant="defaultStable"
              size="auto"
              className={cn(
                "h-7 gap-1 rounded-[6px] px-2.5 text-[12px] font-medium tracking-[-0.24px]",
                "!bg-white !text-[#4f4f4f] border border-grey-dark-100 hover:!bg-grey-light-700",
                "dark:!bg-black-600 dark:!text-grey-light-100 dark:border-black-300 dark:hover:!bg-black-500",
              )}
              onClick={() => setWithdrawOpen(true)}
            >
              <OutGoing className="size-2 shrink-0" />
              Withdraw
            </Button>
          )}
        </div>

        {/* Inner panel — tight `gap-1.5` between row 1 and row 2 keeps
            them visually paired; the action buttons get `mt-auto` so
            they still snap to the bottom of the panel. Mirrors the
            MY BALANCE card next door (same spacing rhythm). */}
        <div
          className={cn(
            "flex flex-col w-full flex-1 gap-1.5",
            "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
            "bg-[#fbfbfb] dark:bg-black-600 dark:border-black-300",
            "p-3",
          )}
        >
          {/* Metrics layout — three slots so this card's vertical
              distribution matches MY BALANCE's (number / "Last updated"
              / buttons). With `justify-between` on the parent, the
              middle slot sits at the same vertical position as the
              "Last updated" row on the Balance card next door.
                Row 1 — first one or two metrics (left + right when 2).
                Row 2 — third metric, OR an empty placeholder when
                        there are only 1-2 metrics, so the layout
                        keeps its three-slot rhythm.
                Buttons — anchored to the bottom of the panel. */}
          {isLoading ? (
            <>
              <div className="h-[30px] w-[140px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse" />
              <div />
            </>
          ) : (
            <>
              <div
                className={cn(
                  "flex items-end gap-3",
                  firstRow.length === 2 && "justify-between",
                )}
              >
                {firstRow.map(renderMetric)}
              </div>
              <div className="flex items-end">
                {secondRow.map(renderMetric)}
              </div>
            </>
          )}

          {/* Stake / Unstake actions — `mt-auto` snaps to the bottom of
              the panel regardless of how many metric rows render above. */}
          <div className="grid grid-cols-2 gap-2 mt-auto">
            <Button
              variant="primary"
              size="auto"
              className="h-[36px] rounded-[8px] text-[13px] font-medium tracking-[-0.26px] gap-[7px]"
              onClick={() => setStakeOpen(true)}
            >
              <StakeNow className="size-3.5 shrink-0" />
              Stake Now
            </Button>
            <Button
              variant="defaultStable"
              size="auto"
              className={cn(
                "h-[36px] rounded-[8px] gap-[7px]",
                "text-[13px] font-medium tracking-[-0.26px]",
                "!bg-white !text-[#4f4f4f] border border-grey-dark-100 hover:!bg-grey-light-700",
                "dark:!bg-black-600 dark:!text-grey-light-100 dark:border-black-300 dark:hover:!bg-black-500",
              )}
              onClick={() => setUnstakeOpen(true)}
              disabled={!hasBonded}
            >
              <UnstakeHalpha className="size-3.5 shrink-0" />
              Unstake hAlpha
            </Button>
          </div>
        </div>
      </div>

      <StakeDialog
        open={stakeOpen}
        onClose={() => setStakeOpen(false)}
        onSuccess={() => refetch()}
      />
      <UnstakeDialog
        open={unstakeOpen}
        onClose={() => setUnstakeOpen(false)}
        onSuccess={() => refetch()}
      />
      <WithdrawDialog
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        onSuccess={() => refetch()}
      />
    </>
  );
};

export default WalletStakeCard;
