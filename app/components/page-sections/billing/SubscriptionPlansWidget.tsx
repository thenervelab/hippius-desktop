"use client";

import { FC, useState } from "react";
import { cn } from "@/lib/utils";
import { Tag2, TagRight, Wallet, Coin, CloseSquare } from "@/components/ui/icons";
import type { Plan } from "./CancelSubscriptionDialog"
import * as Typography from "@/components/ui/typography";
import AbstractIconWrapper from "../../ui/abstract-icon-wrapper";
import { Loader2, MoreVertical } from "lucide-react";
import useSubscriptionData from "@/app/lib/hooks/useSubscriptionData";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import CancelSubscriptionDialog from "./CancelSubscriptionDialog";
import { CardButton } from "../../ui";

interface SubscriptionPlansWidgetProps {
    className?: string;
}

const SubscriptionPlansWidget: FC<SubscriptionPlansWidgetProps> = ({
    className,
}) => {
    const {
        activeSubscription,
        isLoadingActive,
        subscriptionPlans,
    } = useSubscriptionData();

    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

    const handleDialogOpenChange = (open: boolean) => {
        setCancelDialogOpen(open);
    };

    const handleCancelSubscriptionClick = (event: React.MouseEvent | Event) => {
        event.preventDefault();
        setDropdownOpen(false); // Close dropdown when item is clicked
        setCancelDialogOpen(true); // Open the dialog
    };

    const getDaysUntilExpiration = (endDateStr: string) => {
        const endDate = new Date(endDateStr);
        const today = new Date();

        const endDateOnly = new Date(
            endDate.getFullYear(),
            endDate.getMonth(),
            endDate.getDate()
        );

        const todayOnly = new Date(
            today.getFullYear(),
            today.getMonth(),
            today.getDate()
        );

        const timeDiff = endDateOnly.getTime() - todayOnly.getTime();
        return Math.max(0, Math.ceil(timeDiff / (1000 * 60 * 60 * 24)));
    };

    const hasActiveSubscription = activeSubscription?.has_subscription;

    return (
        <div
            className={cn(
                "w-full p-4 flex flex-col border border-grey-80 rounded-lg justify-between relative",
                className
            )}
        >
            <div className="flex flex-col w-full items-start">
                <div className="flex w-full gap-4 items-center justify-between">
                    <div className="flex gap-4 items-center">
                        <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                            <Wallet className="absolute text-primary-40 size-4 sm:size-5" />
                        </AbstractIconWrapper>
                        <span className="text-base font-medium text-grey-60">
                            Your Subscription
                        </span>
                    </div>
                    {hasActiveSubscription && (
                        <DropdownMenu.Root
                            open={dropdownOpen}
                            onOpenChange={setDropdownOpen}
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
                                    className="min-w-[180px] bg-white rounded shadow-lg p-1 border border-grey-80"
                                    sideOffset={5}
                                    align="end"
                                >
                                    <DropdownMenu.Item
                                        className="flex items-center gap-2 px-3 py-1.5 text-error-60 hover:bg-grey-90 outline-none cursor-pointer rounded"
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
                <div className="flex flex-col w-full">


                    {isLoadingActive ? (
                        <div className="flex flex-col items-center justify-center pt-4 pb-5 ">
                            <div className="flex flex-col items-center">
                                <Loader2 className="size-8 text-primary-50 animate-spin mb-2" />
                                <Typography.P size="xs" className="text-grey-50">
                                    Loading subscription...
                                </Typography.P>
                            </div>
                        </div>
                    ) : hasActiveSubscription ? (
                        <div className="mt-4 space-y-4 mb-2">
                            <div className="text-2xl font-medium text-grey-10">
                                {activeSubscription.subscription.plan_name}
                            </div>

                            <div className="flex items-center text-xs">
                                <div className="flex items-center text-grey-30 gap-x-2">
                                    <Coin className="size-4" />
                                    <div className="text-grey-10">
                                        ${activeSubscription.subscription.amount}
                                        <span>/{activeSubscription.subscription.interval}</span>
                                    </div>
                                </div>

                                <span className="h-3 border border-grey-70 mx-1"></span>

                                {activeSubscription.subscription.current_period_end && (
                                    <div className="flex items-center text-grey-70">
                                        <span className="mr-1">Expires in</span>
                                        <span>
                                            {getDaysUntilExpiration(activeSubscription.subscription.current_period_end)} Days
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center pt-7">
                            <AbstractIconWrapper className="size-8 sm:size-10">
                                <TagRight className="absolute size-4 sm:size-6 text-primary-50" />
                            </AbstractIconWrapper>
                            <Typography.P size={"xxs"} className="text-center text-grey-10 pb-2 mt-1">
                                No Active Plan
                            </Typography.P>
                        </div>
                    )}
                </div>
            </div>
            <div className="relative bg-grey-100 w-full border-grey-80 border-t">
                <CardButton
                    className="w-full mt-4 h-[50px]"
                    variant="secondary"
                    asLink
                    href="/billing/plans"
                    disabled={isLoadingActive}
                >
                    <div className="flex items-center gap-2">
                        <Tag2 className="size-4" />
                        <span className="flex items-center">
                            {hasActiveSubscription ? "Upgrade Plan" : "Subscribe to a Plan"}
                        </span>
                    </div>
                </CardButton>
            </div>
            <CancelSubscriptionDialog
                plans={subscriptionPlans as unknown as Plan[]}
                onDialogOpenChange={handleDialogOpenChange}
                open={cancelDialogOpen}
            />
        </div>
    );
};

export default SubscriptionPlansWidget;
