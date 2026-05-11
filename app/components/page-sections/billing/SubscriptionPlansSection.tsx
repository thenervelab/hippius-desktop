"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Building,
  Star as StarIcon,
  TagRight,
  Ticket,
  Coin,
  ArrowRight,
} from "@/components/ui/icons";
import CancelSubscriptionDialog, { Plan } from "./CancelSubscriptionDialog";
import useSubscriptionData from "@/app/lib/hooks/useSubscriptionData";
import { Button } from "@/components/ui/button";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";

interface StorageCapacityInfo {
  storageGb: number;
  storageDisplay: string;
  usageDescription: string;
}

export default function SubscriptionPlansSection() {
  const { polkadotAddress } = useWalletAuth();
  const { subscriptionPlans: plans, isLoadingPlans, activeSubscription } =
    useSubscriptionData();

  const [isSubscribing, setIsSubscribing] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const hasActiveSubscription = activeSubscription?.has_subscription || false;

  // DEV TOOLS — remove before shipping
  const [devMockEnabled, setDevMockEnabled] = useState(false);
  const [devMockPlanName, setDevMockPlanName] = useState("");

  const [storageInfo, setStorageInfo] = useState<
    Record<string, StorageCapacityInfo>
  >({});

  useEffect(() => {
    if (plans.length === 0) return;
    const credits = plans.map((p) => p.credits_per_billing);
    invoke<StorageCapacityInfo[]>("calculate_storage_capacity", {
      creditsPerMonth: credits,
    })
      .then((results) => {
        const map: Record<string, StorageCapacityInfo> = {};
        plans.forEach((plan, i) => {
          map[plan.id] = results[i];
        });
        setStorageInfo(map);
      })
      .catch(() => {});
  }, [plans]);

  const handleSubscribe = async (planId: string) => {
    if (!planId) {
      toast.error("Please select a valid plan");
      return;
    }
    if (!polkadotAddress) {
      toast.error("Not authenticated");
      return;
    }

    setSelectedPlanId(planId);
    setIsSubscribing(true);

    try {
      const selectedPlan = plans.find((plan) => plan.id === planId);
      if (!selectedPlan) throw new Error("Selected plan not found");

      const data = await invoke<{ checkout_url?: string }>(
        "create_subscription",
        {
          accountId: polkadotAddress,
          priceId: selectedPlan.price_id,
          successUrl: `${window.location.origin}/billing/success`,
          cancelUrl: `${window.location.origin}/billing/cancel`,
        },
      );

      if (data.checkout_url) {
        try {
          await openUrl(data.checkout_url);
          toast.success("Stripe checkout opened in your browser");
        } catch {
          toast.error("Failed to open checkout. Please try again.");
        }
      }
    } catch {
      toast.error("Failed to subscribe to plan. Please try again.");
    } finally {
      setIsSubscribing(false);
      setSelectedPlanId(null);
    }
  };

  const getPlanIcon = (index: number) => {
    const icons = [
      <StarIcon key="star" className="size-[18px] text-primary-50" />,
      <TagRight key="tag" className="size-[18px] text-primary-50" />,
      <Ticket key="ticket" className="size-[18px] text-primary-50" />,
      <Building key="building" className="size-[18px] text-primary-50" />,
    ];
    return index < icons.length ? icons[index] : icons[1];
  };

  const isActivePlan = (planName: string) =>
    devMockEnabled
      ? devMockPlanName === planName
      : hasActiveSubscription && activeSubscription?.subscription?.plan_name === planName;

  const handleDialogOpenChange = (open: boolean) => {
    setCancelDialogOpen(open);
  };

  return (
    <div
      className={cn(
        "mt-6 flex flex-col items-center w-full rounded-[8px] border overflow-hidden",
        "bg-grey-light-300 border-grey-dark-100",
        "dark:bg-black-primary-bg dark:border-black-300",
        "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
      )}
    >
      {/* Header row */}
      <div className="flex h-[46px] w-full items-center pl-[14px] pr-[10px]">
        <div className="flex items-center gap-1">
          <Coin className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
            Subscription Plans
          </p>
        </div>
      </div>

      {/* Inner panel */}
      <div
        className={cn(
          "flex flex-col w-full flex-1",
          "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
          "bg-white dark:bg-black-600 dark:border-black-300",
          "p-3",
        )}
      >
        {/* DEV TOOLS — remove before shipping */}
        {process.env.NODE_ENV === "development" && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[6px] border border-dashed border-orange-400 bg-orange-50 dark:bg-orange-950/30 px-3 py-2">
            <span className="font-mono text-[11px] font-bold uppercase text-orange-500">Dev Tools</span>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={devMockEnabled}
                onChange={(e) => {
                  setDevMockEnabled(e.target.checked);
                  if (!e.target.checked) setDevMockPlanName("");
                }}
                className="accent-orange-500"
              />
              <span className="font-mono text-[11px] text-orange-600 dark:text-orange-400">Mock active plan</span>
            </label>
            {devMockEnabled && (
              <select
                value={devMockPlanName}
                onChange={(e) => setDevMockPlanName(e.target.value)}
                className="font-mono text-[11px] rounded border border-orange-300 bg-white dark:bg-black-600 text-orange-600 dark:text-orange-400 px-1.5 py-0.5"
              >
                <option value="">— pick a plan —</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {isLoadingPlans ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 text-primary-50 animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-4 gap-3">
            {plans.map((plan, index) => {
              const isLoading = isSubscribing && selectedPlanId === plan.id;
              const currentActivePlan = isActivePlan(plan.name);

              return (
                <div
                  key={plan.id}
                  className={cn(
                    "flex flex-col rounded-[8px] border overflow-hidden",
                    "bg-grey-light-300 border-grey-dark-100",
                    "dark:bg-black-primary-bg dark:border-black-300",
                  )}
                >
                  {/* Plan card header */}
                  <div className="flex items-center justify-between gap-2 px-2 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {getPlanIcon(index)}
                      <span className="font-medium text-[14px] leading-[18px] tracking-[-0.28px] text-grey-10 dark:text-white truncate">
                        {plan.name}
                      </span>
                    </div>
                    {currentActivePlan && (
                      <span className="flex shrink-0 items-center gap-1">
                        <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-primary-40/20">
                          <span className="size-[6.15px] rounded-full bg-primary-40" />
                        </span>
                        <span className="font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark whitespace-nowrap">
                          {/* $3 & $15 always have room; $150 & $450 abbreviate at 4-column layout */}
                          Active{index < 2
                            ? " Plan"
                            : <span className="@3xl:hidden"> Plan</span>
                          }
                        </span>
                      </span>
                    )}
                  </div>

                  {/* Plan card inner white panel */}
                  <div
                    className={cn(
                      "flex flex-col flex-1",
                      "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
                      "bg-white dark:bg-black-600 dark:border-black-300",
                      "p-3",
                    )}
                  >
                    {/* Price */}
                    <div className="flex items-baseline gap-1">
                      <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                        ${plan.amount}
                      </span>
                      <span className="font-mono font-medium text-[12px] tracking-[-0.48px] text-grey-10 dark:text-white opacity-50">
                        /{plan.interval}
                      </span>
                    </div>

                    {/* Description + storage */}
                    <div className="mt-3 space-y-0.5">
                      <p className="text-[12px] font-medium tracking-[-0.24px] text-grey-dark-600 dark:text-grey-dark-600">
                        {plan.description}
                      </p>
                      {storageInfo[plan.id]?.storageDisplay && (
                        <p className="text-[12px] tracking-[-0.36px] leading-[18px]">
                          <span className="font-bold text-primary-50">
                            {storageInfo[plan.id].storageDisplay}
                          </span>
                          <span className="font-medium text-grey-10 dark:text-white">
                            {" "}storage on Hippius
                          </span>
                        </p>
                      )}
                    </div>

                    {/* Features */}
                    <div className="mt-3 space-y-1 grow">
                      <p className="font-mono font-medium text-[12px] tracking-[-0.24px] text-grey-dark-800 dark:text-grey-dark-700 uppercase mb-1.5">
                        Features
                      </p>
                      <div className="flex items-center gap-2">
                        <ArrowRight className="size-3.5 shrink-0 text-[#B7B7B7]" />
                        <span className="text-[12px] font-medium tracking-[-0.24px] text-grey-10 dark:text-white">
                          Automatic Reload
                        </span>
                      </div>
                      {storageInfo[plan.id]?.usageDescription && (
                        <div className="flex items-center gap-2">
                          <ArrowRight className="size-3.5 shrink-0 text-[#B7B7B7]" />
                          <span className="text-[12px] font-medium tracking-[-0.24px] text-grey-10 dark:text-white">
                            {storageInfo[plan.id].usageDescription}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Subscribe / Cancel button */}
                    <div className="mt-3">
                      {currentActivePlan ? (
                        <Button
                          variant="default"
                          size="auto"
                          className="w-full h-[30px] rounded-[6px] text-[14px] font-medium tracking-[-0.28px]"
                          onClick={() => setCancelDialogOpen(true)}
                        >
                          Cancel Subscription
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          size="auto"
                          className="w-full h-[30px] rounded-[6px] text-[14px] font-medium tracking-[-0.28px]"
                          onClick={() => handleSubscribe(plan.id)}
                          disabled={isSubscribing}
                          loading={isLoading}
                        >
                          {isLoading ? "Processing..." : "Subscribe"}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <CancelSubscriptionDialog
        plans={plans as unknown as Plan[]}
        onDialogOpenChange={handleDialogOpenChange}
        open={cancelDialogOpen}
      />
    </div>
  );
}
