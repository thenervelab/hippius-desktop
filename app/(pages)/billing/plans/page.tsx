"use client";

import { useMemo, useState } from "react";
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
import CancelSubscriptionDialog, {
  Plan,
} from "@/app/components/page-sections/billing/CancelSubscriptionDialog";
import useSubscriptionData from "@/app/lib/hooks/useSubscriptionData";
import ButtonCard from "@/app/components/ui/button/CardButton";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import { GoBackButton } from "@/app/components/ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  calculateStorageCost,
  DEFAULT_TIMING_OPTION,
} from "@/app/lib/utils/storageCostUtils";
import pricingJson from "@/app/utils/data/pricing-cfg.json";
import SectionHeader from "@/app/components/page-sections/settings/SectionHeader";

export default function PlansPage() {
  const { polkadotAddress } = useWalletAuth();
  const {
    subscriptionPlans: plans,
    isLoadingPlans,
    activeSubscription,
  } = useSubscriptionData();

  const [isSubscribing, setIsSubscribing] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const hasActiveSubscription = activeSubscription?.has_subscription || false;
  // Calculate storage capacity based on credits (1 credit = $1)
  const calculateStorageFromCredits = (creditsPerMonth: number): number => {
    // Binary search to find max GB that can be stored with given credits
    let low = 0;
    let high = 1000000; // Start with reasonable upper bound
    let maxGB = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const monthlyCost = calculateStorageCost({
        storageTypeData: pricingJson.storage.ipfs,
        perBlockTime: pricingJson.per_block_time_s,
        timeframe: DEFAULT_TIMING_OPTION,
        numOfGb: mid,
      });

      if (monthlyCost <= creditsPerMonth) {
        maxGB = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return maxGB;
  };

  // Get storage capacity for each plan
  const getStorageCapacity = useMemo(() => {
    return plans.reduce((acc, plan) => {
      const storageGB = calculateStorageFromCredits(plan.credits_per_billing);
      acc[plan.id] = storageGB;
      return acc;
    }, {} as Record<string, number>);
  }, [plans]);

  // Get ideal usage description for each plan
  const getIdealUsageDescription = (credits: number): string => {
    if (credits <= 3) return "Ideal for Personal Backups";
    if (credits <= 15) return "Ideal for Small Businesses";
    if (credits <= 50) return "Ideal for Growing Businesses";
    if (credits <= 100) return "Ideal for Scaling Businesses";
    if (credits <= 150) return "Ideal for Medium Businesses";
    if (credits <= 450) return "Ideal for Large Businesses";
    return "Enterprise Level Solution";
  };

  // Format storage display (GB for small amounts, TB for larger)
  const formatStorageDisplay = (storageGB: number, credits: number): string => {
    if (credits <= 3) {
      // Show both GB and TB for the 3 credits plan only, round GB to nearest thousand
      const roundedGB = Math.round(storageGB / 1000) * 1000;
      const storageTB = Math.round(storageGB / 1000);
      return `≈${roundedGB} GB / ${storageTB} TB Storage on Hippius`;
    } else {
      // Show only TB for other plans, remove decimal places
      const storageTB = Math.round(storageGB / 1000);
      return `≈${storageTB} TB Storage on Hippius`;
    }
  };
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
      if (!selectedPlan) {
        throw new Error("Selected plan not found");
      }

      const data = await invoke<{ checkout_url?: string }>(
        "create_subscription",
        {
          accountId: polkadotAddress,
          priceId: selectedPlan.price_id,
          successUrl: `${window.location.origin}/billing/success`,
          cancelUrl: `${window.location.origin}/billing/cancel`,
        }
      );

      if (data.checkout_url) {
        try {
          await openUrl(data.checkout_url);
          toast.success("Stripe checkout opened in your browser");
        } catch (error) {
          console.error("Error opening checkout:", error);
          toast.error("Failed to open checkout. Please try again.");
        }
      }
    } catch (error) {
      console.error("Error subscribing to plan:", error);
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
        className="absolute size-4 sm:size-6 text-primary-50"
      />,
      <TagRight
        key="tag"
        className="absolute size-4 sm:size-6 text-primary-50"
      />,
      <Ticket
        key="ticket"
        className="absolute size-4 sm:size-6 text-primary-50"
      />,
      <Building
        key="building"
        className="absolute size-4 sm:size-6 text-primary-50"
      />,
    ];

    return index < icons.length ? icons[index] : icons[1];
  };

  const isActivePlan = (planName: string) =>
    hasActiveSubscription &&
    activeSubscription?.subscription?.plan_name === planName;

  const handleDropdownOpenChange = (open: boolean, planId: string) => {
    if (open) {
      setOpenDropdownId(planId);
    } else if (openDropdownId === planId) {
      setOpenDropdownId(null);
    }
  };

  const handleDialogOpenChange = (open: boolean) => {
    setCancelDialogOpen(open);
    if (!open) {
      setOpenDropdownId(null);
    }
  };

  const handleCancelSubscriptionClick = (event: Event) => {
    event.preventDefault();
    setOpenDropdownId(null); // Close dropdown
    setCancelDialogOpen(true); // Open dialog
  };

  if (isLoadingPlans) {
    return (
      <DashboardTitleWrapper mainText="">
        <div className="w-full py-4">
          <div className="mb-4">
            <GoBackButton href="/billing" />
          </div>
          <div className="flex items-center mb-6 sm:mb-8">
            <SectionHeader
              Icon={Tag2}
              title="Subscription Plans"
              subtitle="All services are billed per use with credits (1 credit = $1), minted on our blockchain for full visibility."
            />
          </div>
          <div className="flex flex-col items-center justify-center py-16">
            <Loader2 className="size-8 text-primary-50 animate-spin mb-4" />
            <p className="text-grey-40">Loading subscription plans...</p>
          </div>
        </div>
      </DashboardTitleWrapper>
    );
  }

  return (
    <DashboardTitleWrapper mainText="Billing">
      <div className="container py-8">
        <div className="mb-4">
          <GoBackButton href="/billing" />
        </div>
        <div className="flex items-center mb-6 sm:mb-8">
          <SectionHeader
            Icon={Tag2}
            title="Subscription Plans"
            subtitle={
              <>
                All services are billed per use with credits{" "}
                <span className="font-bold text-grey-50">
                  {" "}
                  (1 credit = $1){" "}
                </span>
                , minted on our blockchain for full visibility..
              </>
            }
          />
        </div>

        <div className="flex flex-wrap gap-4">
          {plans.map((plan, index) => {
            const isLoading = isSubscribing && selectedPlanId === plan.id;
            const currentActivePlan = isActivePlan(plan.name);

            return (
              <div
                key={plan.id}
                className="p-4 border rounded-lg overflow-hidden relative border-grey-80 w-full sm:max-w-[300px]"
              >
                <div>
                  <div className="flex flex-col mb-1">
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
                              className="flex items-center justify-center h-6 w-6 rounded border border-grey-80 bg-grey-100 hover:bg-grey-90 transition-colors"
                              aria-label="More options"
                            >
                              <MoreVertical className="size-4 text-grey-50" />
                            </button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              className="min-w-[180px] bg-grey-100 rounded shadow-lg p-1 border border-grey-80 z-20"
                              sideOffset={5}
                              align="end"
                            >
                              <DropdownMenu.Item
                                className="flex items-center gap-2 px-3 py-1.5 text-error-80 hover:bg-grey-90 outline-none cursor-pointer rounded"
                                onSelect={(event) => {
                                  event.preventDefault();
                                  handleCancelSubscriptionClick(event);
                                }}
                              >
                                <div className="flex items-center gap-2 w-full text-left">
                                  <CloseSquare className="size-4" />
                                  <span className="text-base">
                                    Cancel Subscription
                                  </span>
                                </div>
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      )}
                    </div>

                    <h3 className="text-[24px] font-medium text-primary-40 mt-4">
                      {plan.name}
                    </h3>
                  </div>

                  <p className="text-lg text-grey-60 mt-2">
                    ${plan.amount}/{plan.interval}
                  </p>

                  <div className="text-base font-medium text-grey-60 mt-2">
                    <div>{plan.description}</div>
                    <div className="text-sm text-primary-50 mt-1">
                      {formatStorageDisplay(
                        getStorageCapacity[plan.id] || 0,
                        plan.credits_per_billing
                      )}
                    </div>
                  </div>

                  <div className="py-4 relative bg-grey-100 w-full border-grey-80 border-b-[2px]">
                    <ButtonCard
                      className="w-full"
                      variant={currentActivePlan ? "secondary" : "primary"}
                      onClick={() => handleSubscribe(plan.id)}
                      disabled={isSubscribing || currentActivePlan}
                      loading={isLoading}
                    >
                      {isLoading
                        ? "Processing..."
                        : currentActivePlan
                          ? "Your Active Plan"
                          : "Subscribe"}
                    </ButtonCard>
                  </div>

                  <div className="space-y-4">
                    <h3 className="text-base font-medium text-grey-60 mt-4">
                      Features
                    </h3>

                    <div className="flex items-center">
                      <CircularTickGrid />
                      <span className="text-grey-10 text-base font-medium ml-2">
                        Automatic Reload
                      </span>
                    </div>

                    <div className="flex items-center">
                      <CircularTickGrid />
                      <span className="text-grey-10 text-base font-medium ml-2">
                        {getIdealUsageDescription(plan.credits_per_billing)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <CancelSubscriptionDialog
            plans={plans as unknown as Plan[]}
            onDialogOpenChange={handleDialogOpenChange}
            open={cancelDialogOpen}
          />
        </div>
      </div>
    </DashboardTitleWrapper>
  );
}
