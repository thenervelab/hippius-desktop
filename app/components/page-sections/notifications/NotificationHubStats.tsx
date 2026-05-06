"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useStaking } from "@/app/lib/hooks/useStaking";
import useSubscriptionData from "@/app/lib/hooks/useSubscriptionData";

const NotificationHubStats: React.FC = () => {
  const router = useRouter();
  const { stakingInfo } = useStaking();
  const { activeSubscription, isLoading: isSubLoading } = useSubscriptionData();

  const stakedDisplay = stakingInfo.isLoading
    ? "—"
    : stakingInfo.bondedHip || "0 HIP";

  const planDisplay = (() => {
    if (isSubLoading) return "—";
    if (!activeSubscription?.has_subscription) return "No plan";
    const sub = activeSubscription.subscription;
    const storage = sub.storage_limit ?? sub.plan_name ?? "—";
    const price =
      sub.amount != null
        ? `$${sub.amount}/${sub.interval === "month" ? "mo." : sub.interval}`
        : "";
    return price ? `${storage} (${price})` : storage;
  })();

  const hasActivePlan = !isSubLoading && !!activeSubscription?.has_subscription;

  return (
    /* Figma: fill=#f3f3f3, stroke=#f4f4f4, radius=8, px=14 */
    <div className="flex items-stretch bg-[#f3f3f3] border border-[#f4f4f4] rounded-lg overflow-hidden shrink-0">
      {/* Wallet / Staking — Figma: border-r=#e3e3e3, pr=20, py=11 */}
      <div className="flex items-center gap-8 pl-3.5 pr-5 py-[11px] border-r border-[#e3e3e3]">
        <div className="flex flex-col gap-0.5">
          {/* Figma: label text=Geist w700 12px #3067dd tracking=-0.36 */}
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[#3067dd]">
            Wallet
          </span>
          <span className="text-[12px] font-bold text-[#3067dd] tracking-[-0.036em] leading-[18px]">
            {stakedDisplay} staked
          </span>
        </div>
        {/* Figma: Stake button fill=#3067dd, radius=6, px=16, py=8, text white Geist w500 14px */}
        <button
          onClick={() => router.push("/stake?tab=stake")}
          className="px-4 py-2 rounded-md text-white text-[14px] font-medium tracking-[-0.02em] hover:opacity-90 transition-opacity"
          style={{ backgroundColor: "#3067dd" }}
        >
          Stake
        </button>
      </div>

      {/* Active Plan — Figma: pl=20, pr=20, py=11 */}
      <div className="flex items-center px-5 py-[11px]">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <span
              className="size-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: hasActivePlan ? "#3067dd" : "#b6b6b6" }}
            />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#3067dd]">
              Active Plan
            </span>
          </div>
          <span className="text-[12px] font-bold text-[#3067dd] tracking-[-0.036em] leading-[18px]">
            {planDisplay}
          </span>
        </div>
      </div>
    </div>
  );
};

export default NotificationHubStats;
