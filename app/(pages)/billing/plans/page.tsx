"use client";

import { useState } from "react";
import { Loader2, MoreVertical } from "lucide-react";
import { toast } from "sonner";
import { Building, CircularTickGrid, CloseSquare, Star as StarIcon, TagRight, Ticket } from "@/components/ui/icons";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import CancelSubscriptionDialog, { Plan } from "@/app/components/page-sections/billing/CancelSubscriptionDialog";
import useSubscriptionData from "@/app/lib/hooks/useSubscriptionData";
import ButtonCard from "@/app/components/ui/button/CardButton";
import { getAuthHeaders } from "@/app/lib/services/authService";
import { ensureBillingAuth } from "@/app/lib/hooks/api/useBillingAuth";
import { API_CONFIG } from "@/app/lib/helpers/sessionStore";
import DashboardTitleWrapper from "@/app/components/dashboard-title-wrapper";
import { GoBackButton } from "@/app/components/ui";
import { openUrl } from "@tauri-apps/plugin-opener";

export default function PlansPage() {
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

    const handleSubscribe = async (planId: string) => {
        if (!planId) {
            toast.error("Please select a valid plan");
            return;
        }

        setSelectedPlanId(planId);
        setIsSubscribing(true);

        try {
            // Ensure authentication is valid
            const authOk = await ensureBillingAuth();
            if (!authOk.ok) {
                toast.error(authOk.error || "Authentication failed");
                setIsSubscribing(false);
                setSelectedPlanId(null);
                return;
            }

            const headers = await getAuthHeaders();
            if (!headers) {
                toast.error("Not authenticated");
                setIsSubscribing(false);
                setSelectedPlanId(null);
                return;
            }

            const selectedPlan = plans.find(plan => plan.id === planId);
            if (!selectedPlan) {
                throw new Error("Selected plan not found");
            }

            const response = await fetch(`${API_CONFIG.baseUrl}/api/billing/stripe/create-subscription/`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    price_id: selectedPlan.price_id,
                    success_url: `${window.location.origin}/billing/success`,
                    cancel_url: `${window.location.origin}/billing/cancel`,
                }),
            });

            if (!response.ok) {
                toast.error("Failed to subscribe to plan. Please try again.");
            } else {
                const data = await response.json();
                if (data.checkout_url) {
                    window.open(data.checkout_url, "_blank");
                    try {
                        await openUrl(data.checkout_url);
                        toast.success("Stripe checkout opened in a your browser");
                    } catch (error) {
                        console.error("Error subscribing to plan:", error);
                        toast.error("Failed to subscribe to plan. Please try again.");
                    }
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
            <StarIcon key="star" className="absolute size-4 sm:size-6 text-primary-50" />,
            <TagRight key="tag" className="absolute size-4 sm:size-6 text-primary-50" />,
            <Ticket key="ticket" className="absolute size-4 sm:size-6 text-primary-50" />,
            <Building key="building" className="absolute size-4 sm:size-6 text-primary-50" />
        ];

        return index < icons.length ? icons[index] : icons[1];
    };

    const isActivePlan = (planName: string) =>
        hasActiveSubscription && activeSubscription?.subscription?.plan_name === planName;

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
            <DashboardTitleWrapper mainText="Billing Plans">
                <div className="container py-8">
                    <div className="flex items-center mb-6">
                        {/* <Link href="/billing" className="group hover:opacity-70 duration-300">
                            <ArrowLeft className="origin-center duration-300 group-hover:-translate-x-1 size-6 text-grey-30" />
                        </Link>
                        <h1 className="text-[22px] font-medium text-grey-10 ml-2">Plans</h1> */}
                        <GoBackButton href="/billing" />
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
        <DashboardTitleWrapper mainText="Billing Plans">
            <div className="container py-8">
                <div className="flex items-center mb-6">
                    <GoBackButton href="/billing" />
                </div>

                <div className="flex flex-wrap gap-4">
                    {plans.map((plan, index) => {
                        const isLoading = isSubscribing && selectedPlanId === plan.id;
                        const currentActivePlan = isActivePlan(plan.name);

                        return (
                            <div
                                key={plan.id}
                                className="p-4 border rounded-lg overflow-hidden relative border-grey-80 w-full sm:max-w-[287px]"
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
                                                    onOpenChange={(open) => handleDropdownOpenChange(open, plan.id)}
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
                                                            className="min-w-[180px] bg-white rounded shadow-lg p-1 border border-grey-80 z-20"
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
                                                                    <span className="text-base">Cancel Subscription</span>
                                                                </div>
                                                            </DropdownMenu.Item>
                                                        </DropdownMenu.Content>
                                                    </DropdownMenu.Portal>
                                                </DropdownMenu.Root>
                                            )}
                                        </div>

                                        <h3 className="text-[24px] font-medium text-primary-40 mt-4">{plan.name}</h3>
                                    </div>

                                    <p className="text-lg text-grey-60 mt-2">
                                        ${plan.amount}/{plan.interval}
                                    </p>

                                    <div className="text-base font-medium text-grey-60">
                                        {plan.description}
                                    </div>

                                    <div className="py-4 relative bg-grey-100 w-full border-grey-80 border-b-[2px]">
                                        <ButtonCard
                                            className="w-full"
                                            variant={currentActivePlan ? "secondary" : "primary"}
                                            onClick={() => handleSubscribe(plan.id)}
                                            disabled={isSubscribing || currentActivePlan}
                                            loading={isLoading}
                                        >
                                            {isLoading ? "Processing..." : currentActivePlan ? "Your Active Plan" : "Subscribe"}
                                        </ButtonCard>
                                    </div>

                                    <div className="space-y-4">
                                        <h3 className="text-base font-medium text-grey-60 mt-4">Features</h3>

                                        <div className="flex items-center">
                                            <CircularTickGrid />
                                            <span className="text-grey-10 text-lg font-medium ml-2">
                                                {plan.credits_per_billing} Credits per {plan.interval}
                                            </span>
                                        </div>

                                        <div className="flex items-center">
                                            <CircularTickGrid />
                                            <span className="text-grey-10 text-lg font-medium ml-2">
                                                Automatic Reload
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
