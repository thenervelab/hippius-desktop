"use client";

import { useEffect, useState } from "react";
import { Loader2, MoreVertical } from "lucide-react";
import { toast } from "sonner";
import {
  Building,
  CircularTickGrid,
  CloseSquare,
  Star as StarIcon,
  Tag2,
  TagRight,
  Ticket,
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
      <StarIcon
        key="star"
        className="absolute size-4 sm:size-5 text-primary-50"
      />,
      <TagRight
        key="tag"
        className="absolute size-4 sm:size-5 text-primary-50"
      />,
      <Ticket
        key="ticket"
        className="absolute size-4 sm:size-5 text-primary-50"
      />,
      <Building
        key="building"
        className="absolute size-4 sm:size-5 text-primary-50"
      />,
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
    <div className="mt-6">
      {/* Section header */}
      <div className="flex items-center gap-2 mb-4">
        <AbstractIconWrapper className="size-7 text-primary-40">
          <Tag2 className="absolute size-3.5 text-primary-40" />
        </AbstractIconWrapper>
        <span className="font-mono text-[12px] font-medium uppercase tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
          Subscription Plans
        </span>
      </div>

      {isLoadingPlans ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 text-primary-50 animate-spin" />
        </div>
      ) : (
        <div className="grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-4 gap-4">
          {plans.map((plan, index) => {
            const isLoading = isSubscribing && selectedPlanId === plan.id;
            const currentActivePlan = isActivePlan(plan.name);

            return (
              <div
                key={plan.id}
                className={cn(
                  "p-4 border rounded-lg flex flex-col relative border-grey-80",
                  currentActivePlan && "border-primary-40",
                )}
              >
                {/* Icon + dropdown */}
                <div className="flex items-center justify-between text-primary-40">
                  <AbstractIconWrapper className="size-8 sm:size-10">
                    {getPlanIcon(index)}
                  </AbstractIconWrapper>
                  {currentActivePlan && (
                    <DropdownMenu.Root
                      open={openDropdownId === plan.id}
                      onOpenChange={(open) =>
                        handleDropdownOpenChange(open, plan.id)
                      }
                    >
                      <DropdownMenu.Trigger asChild>
                        <button
                          className="flex items-center justify-center h-6 w-6 rounded border border-grey-80 bg-white hover:bg-grey-90 transition-colors"
                          aria-label="More options"
                        >
                          <MoreVertical className="size-4 text-grey-50" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          className="min-w-[11.25rem] bg-white rounded shadow-lg p-1 border border-grey-80 z-20"
                          sideOffset={5}
                          align="end"
                        >
                          <DropdownMenu.Item
                            className="flex items-center gap-2 px-3 py-1.5 text-error-80 hover:bg-grey-90 outline-none cursor-pointer rounded"
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

                {/* Plan name */}
                <h3 className="text-[1.5rem] font-medium text-primary-40 mt-4">
                  {plan.name}
                </h3>

                {/* Price */}
                <p className="text-lg text-grey-60 mt-2">
                  ${plan.amount}/{plan.interval}
                </p>

                {/* Description + storage */}
                <div className="text-base font-medium text-grey-60 mt-2">
                  <div>{plan.description}</div>
                  <div className="text-sm text-primary-50 mt-1">
                    {storageInfo[plan.id]?.storageDisplay || "Calculating..."}
                  </div>
                </div>

                {/* Features */}
                <div className="space-y-3 mt-4 grow">
                  <h4 className="text-base font-medium text-grey-60 uppercase text-xs tracking-wide">
                    Features
                  </h4>
                  <div className="flex items-center">
                    <CircularTickGrid className="size-9 shrink-0" />
                    <span className="text-grey-10 text-base font-medium ml-2">
                      Automatic Reload
                    </span>
                  </div>
                  {storageInfo[plan.id]?.usageDescription && (
                    <div className="flex items-center">
                      <CircularTickGrid className="size-9 shrink-0" />
                      <span className="text-grey-10 text-base font-medium ml-2">
                        {storageInfo[plan.id].usageDescription}
                      </span>
                    </div>
                  )}
                </div>

                {/* Subscribe button */}
                <div className="mt-4 pt-4 border-t border-grey-80">
                  <Button
                    variant={currentActivePlan ? "defaultStable" : "primary"}
                    size="auto"
                    className="w-full h-[40px] rounded-[8px] text-[14px] font-medium tracking-[-0.28px]"
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
            );
          })}
        </div>
      )}

      <CancelSubscriptionDialog
        plans={plans as unknown as Plan[]}
        onDialogOpenChange={handleDialogOpenChange}
        open={cancelDialogOpen}
      />
    </div>
  );
}
