"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BackButton, Icons } from "@/components/ui";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import TokenForm from "../wallet/shared/TokenForm";
import { toast } from "sonner";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";

const StakeBridge = () => {
    const searchParams = useSearchParams();
    const router = useRouter();
    const tabParam = searchParams.get("tab");

    // Set initial tab based on URL parameter, default to "Stake hAlpha"
    const [activeTab, setActiveTab] = useState(() => {
        return tabParam === "bridge" ? "Bridge hAlpha" : "Stake hAlpha";
    });

    // Update URL when tab changes
    useEffect(() => {
        const newTab = activeTab === "Bridge hAlpha" ? "bridge" : "stake";
        const currentPath = window.location.pathname;
        const newUrl = `${currentPath}?tab=${newTab}`;
        router.replace(newUrl, { scroll: false });
    }, [activeTab, router]);

    const tabs: TabOption[] = [
        {
            tabName: "Stake hAlpha",
            icon: <Icons.Refresh className="size-4" />,
        },
        {
            tabName: "Bridge hAlpha",
            icon: <Icons.Repeat className="size-4" />,
        },
    ];

    const handleStakeSubmit = () => {
        toast.info("This feature is coming soon!");
    };

    const handleBridgeSubmit = () => {
        toast.info("This feature is coming soon!");
    };

    return (
        <DashboardTitleWrapper mainText="Wallet">
            <div className="mb-6">
                <BackButton text="Go Back" href="/wallet" />
            </div>

            {/* Tabs */}
            <div className="flex justify-center mb-8">
                <TabList
                    tabs={tabs}
                    activeTab={activeTab}
                    onTabChange={setActiveTab}
                    width="min-w-[140px]"
                    gap="gap-1"
                />
            </div>

            {/* Content */}
            {activeTab === "Stake hAlpha" && (
                <TokenForm
                    title="Stake hAlpha"
                    description="Stake your hAlpha tokens on Hippius"
                    balanceLabel="hALpha Balance"
                    balanceAmount="413,000.00"
                    inputPlaceholder="Enter Amount to Stake"
                    buttonText="Stake Now"
                    buttonIcon={<Icons.Refresh className="size-4" />}
                    onSubmit={handleStakeSubmit}
                    showStakedAmount
                    stakedAmount="0.00 hAlpha"
                />
            )}

            {activeTab === "Bridge hAlpha" && (
                <TokenForm
                    title="Bridge hAlpha"
                    description="Swap hALPHA and TAO without leaving the Hippius easily"
                    balanceLabel="hAlpha Balance"
                    balanceAmount="413,000.00"
                    inputPlaceholder="You Send"
                    buttonText="Bridge Now"
                    buttonIcon={<Icons.Repeat className="size-4" />}
                    onSubmit={handleBridgeSubmit}
                    showEstimateAndFees={true}
                    estimatedTime="0 Seconds"
                    gasFees="0.00 hALPHA"
                />
            )}
        </DashboardTitleWrapper>
    );
};

export default StakeBridge;