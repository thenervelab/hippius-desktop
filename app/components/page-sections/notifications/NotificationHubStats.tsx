"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { Icons } from "@/components/ui";
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
    const price = sub.amount != null ? `$${sub.amount}/${sub.interval === "month" ? "mo." : sub.interval}` : "";
    return price ? `${storage} (${price})` : storage;
  })();

  const hasActivePlan =
    !isSubLoading && !!activeSubscription?.has_subscription;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Wallet / Staking */}
      <div className="flex items-center gap-3 px-4 py-2.5 border border-grey-80 rounded-lg bg-white">
        <div className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-primary-50">
          <Icons.Wallet className="size-3.5" />
          Wallet
        </div>
        <div className="h-4 w-px bg-grey-80" />
        <span className="text-sm font-semibold text-grey-10">{stakedDisplay}</span>
        <span className="text-xs text-grey-50">staked</span>
        <button
          onClick={() => router.push("/stake?tab=stake")}
          className="ml-1 px-3 h-7 rounded-lg border border-grey-80 text-xs font-semibold text-grey-10 hover:bg-grey-95 hover:border-grey-60 transition-colors"
        >
          Stake
        </button>
      </div>

      {/* Active Plan */}
      <div className="flex items-center gap-3 px-4 py-2.5 border border-grey-80 rounded-lg bg-white">
        <div className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-primary-50">
          <span
            className={`size-2 rounded-full ${hasActivePlan ? "bg-primary-50" : "bg-grey-60"}`}
          />
          Active Plan
        </div>
        <div className="h-4 w-px bg-grey-80" />
        <span className="text-sm font-semibold text-grey-10">{planDisplay}</span>
      </div>
    </div>
  );
};

export default NotificationHubStats;
