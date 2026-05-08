"use client";

import { useEffect, useState } from "react";
import { Loader2, MoreVertical } from "lucide-react";
import { toast } from "sonner";
import {
  Building,
  CloseSquare,
  Star as StarIcon,
  TagRight,
  Ticket,
  Coin,
  ArrowRight,
} from "@/components/ui/icons";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
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
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const hasActiveSubscription = activeSubscription?.has_subscription || false;

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
      <StarIcon key="star" className="absolute size-3.5 text-primary-50" />,
      <TagRight key="tag" className="absolute size-3.5 text-primary-50" />,
      <Ticket key="ticket" className="absolute size-3.5 text-primary-50" />,
      <Building key="building" className="absolute size-3.5 text-primary-50" />,
    ];
    return index < icons.length ? icons[index] : icons[1];
  };

  const isActivePlan = (planName: string) =>
    hasActiveSubscription &&
    activeSubscription?.subscription?.plan_name === planName;

  const handleDropdownOpenChange = (open: boolean, planId: string) => {
    if (open) setOpenDropdownId(planId);
    else if (openDropdownId === planId) setOpenDropdownId(null);
  };

  const handleDialogOpenChange = (open: boolean) => {
    setCancelDialogOpen(open);
    if (!open) setOpenDropdownId(null);
  };

  const handleCancelSubscriptionClick = (event: Event) => {
    event.preventDefault();
    setOpenDropdownId(null);
    setCancelDialogOpen(true);
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
                    currentActivePlan && "border-primary-40 dark:border-primary-40",
                  )}
                >
                  {/* Plan card header */}
                  <div className="flex items-center justify-between px-2 py-2">
                    <div className="flex items-center gap-1.5">
                      <AbstractIconWrapper className="size-7 text-primary-40">
                        {getPlanIcon(index)}
                      </AbstractIconWrapper>
                      <span className="font-medium text-[14px] leading-[18px] tracking-[-0.28px] text-grey-10 dark:text-white">
                        {plan.name}
                      </span>
                    </div>
                    {currentActivePlan && (
                      <DropdownMenu.Root
                        open={openDropdownId === plan.id}
                        onOpenChange={(open) =>
                          handleDropdownOpenChange(open, plan.id)
                        }
                      >
                        <DropdownMenu.Trigger asChild>
                          <button
                            className="flex items-center justify-center h-6 w-6 rounded border border-grey-80 bg-white hover:bg-grey-90 transition-colors dark:bg-black-600 dark:border-black-300"
                            aria-label="More options"
                          >
                            <MoreVertical className="size-4 text-grey-50" />
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            className="min-w-[11.25rem] bg-white rounded shadow-lg p-1 border border-grey-80 z-20 dark:bg-black-600 dark:border-black-300"
                            sideOffset={5}
                            align="end"
                          >
                            <DropdownMenu.Item
                              className="flex items-center gap-2 px-3 py-1.5 text-error-80 hover:bg-grey-90 outline-none cursor-pointer rounded dark:hover:bg-black-primary-bg"
                              onSelect={handleCancelSubscriptionClick}
                            >
                              <CloseSquare className="size-4" />
                              <span className="text-base">
                                Cancel Subscription
                              </span>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
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
                    <p className="text-[20px] font-medium leading-[26px] tracking-[-0.4px] text-grey-10 dark:text-white">
                      ${plan.amount}
                      <span className="text-[13px] font-medium text-grey-50 dark:text-grey-dark-500 ml-0.5">
                        /{plan.interval}
                      </span>
                    </p>

                    {/* Description + storage */}
                    <div className="mt-1.5">
                      <p className="text-[12px] font-medium text-grey-50 dark:text-grey-dark-500">
                        {plan.description}
                      </p>
                      {storageInfo[plan.id]?.storageDisplay && (
                        <p className="text-[12px] font-medium text-primary-50 mt-0.5">
                          {storageInfo[plan.id].storageDisplay}
                        </p>
                      )}
                    </div>

                    {/* Features */}
                    <div className="space-y-2 mt-3 grow">
                      <div className="flex items-center gap-1.5">
                        <ArrowRight className="size-3.5 shrink-0 text-primary-50" />
                        <span className="text-[12px] font-medium text-grey-10 dark:text-white">
                          Automatic Reload
                        </span>
                      </div>
                      {storageInfo[plan.id]?.usageDescription && (
                        <div className="flex items-center gap-1.5">
                          <ArrowRight className="size-3.5 shrink-0 text-primary-50" />
                          <span className="text-[12px] font-medium text-grey-10 dark:text-white">
                            {storageInfo[plan.id].usageDescription}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Subscribe button */}
                    <div className="mt-3 pt-3 border-t border-grey-dark-100 dark:border-black-300">
                      <Button
                        variant={currentActivePlan ? "defaultStable" : "primary"}
                        size="auto"
                        className="w-full h-[32px] rounded-[6px] text-[13px] font-medium tracking-[-0.26px]"
                        onClick={() => handleSubscribe(plan.id)}
                        disabled={isSubscribing || !!currentActivePlan}
                        loading={isLoading}
                      >
                        {isLoading
                          ? "Processing..."
                          : currentActivePlan
                            ? "Your Active Plan"
                            : "Subscribe"}
                      </Button>
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
