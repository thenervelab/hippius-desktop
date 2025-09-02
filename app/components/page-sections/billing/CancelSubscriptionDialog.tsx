import { FC, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CloseCircle } from "@/components/ui/icons";
import { P } from "@/components/ui/typography";
import { toast } from "sonner";
import useSubscriptionData from "@/app/lib/hooks/useSubscriptionData";
import ButtonCard from "../../ui/button/CardButton";
import { Graphsheet } from "../../ui";
import { getAuthHeaders } from "@/app/lib/services/authService";
import { ensureBillingAuth } from "@/app/lib/hooks/api/useBillingAuth";
import { API_CONFIG } from "@/app/lib/helpers/sessionStore";

export interface Plan {
    name: string;
    description?: string;
    credits_per_billing: number | string;
    interval: string;
    [key: string]: unknown; // For any additional properties
}

interface CancelSubscriptionDialogProps {
    plans?: Plan[];
    onDialogOpenChange?: (open: boolean) => void;
    open?: boolean;
    trigger?: React.ReactNode;
}

const CancelSubscriptionDialog: FC<CancelSubscriptionDialogProps> = ({
    plans,
    onDialogOpenChange,
    open,
    trigger,
}) => {
    const [internalOpen, setInternalOpen] = useState(false);
    const [isCancelling, setIsCancelling] = useState(false);
    const { activeSubscription, subscriptionPlans } = useSubscriptionData();

    // Use either the external open state or internal state
    const dialogOpen = open !== undefined ? open : internalOpen;

    const plansToUse = plans || subscriptionPlans;

    const currentPlanDetails = plansToUse?.find(
        (plan) => plan.name === activeSubscription?.subscription?.plan_name
    );

    const handleDialogOpenChange = (newOpenState: boolean) => {
        // Update internal state if we're not controlled externally
        if (open === undefined) {
            setInternalOpen(newOpenState);
        }

        // Notify parent component
        if (onDialogOpenChange) {
            onDialogOpenChange(newOpenState);
        }
    };

    const handleCancelSubscription = async () => {
        try {
            setIsCancelling(true);

            // Ensure authentication is valid
            const authOk = await ensureBillingAuth();
            if (!authOk.ok) {
                toast.error(authOk.error || "Authentication failed");
                return;
            }

            const headers = await getAuthHeaders();
            if (!headers) {
                toast.error("Not authenticated");
                return;
            }

            const response = await fetch(`${API_CONFIG.baseUrl}/api/billing/stripe/customer-portal/`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    return_url: `${window.location.origin}/dashboard/billing`,
                }),
            });

            if (!response.ok) {
                throw new Error("Failed to get customer portal link");
            }

            const data = await response.json();
            if (data.portal_url) {
                handleDialogOpenChange(false);
                window.open(data.portal_url, "_blank");
            } else {
                throw new Error("No portal URL returned");
            }
        } catch (error) {
            console.error("Error getting customer portal:", error);
            toast.error("Failed to open subscription management portal");
        } finally {
            setIsCancelling(false);
        }
    };

    const getPlanFeatures = () => {
        if (!currentPlanDetails) return [];

        const features = [];

        if (currentPlanDetails.description) {
            features.push(`${currentPlanDetails.description}`);
        }
        features.push(`${currentPlanDetails.credits_per_billing} Credits per ${currentPlanDetails.interval}`);
        features.push("Automatic Reload");

        return features;
    };

    return (
        <Dialog.Root open={dialogOpen} onOpenChange={handleDialogOpenChange}>
            {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
            <Dialog.Portal>
                <Dialog.Overlay className="bg-white/70 fixed px-4 z-10 top-0 w-full h-full flex items-center justify-center data-[state=open]:animate-fade-in-0.3">
                    <Dialog.Content className="relative p-4 border shadow-dialog bg-white flex flex-col max-w-[428px] max-h-[75vh] h-auto overflow-y-auto custom-scrollbar-thin border-grey-80 bg-background-1 rounded sm:rounded-[8px] overflow-hidden w-full data-[state=open]:animate-scale-in-95-0.2">
                        <div className="z-10 absolute top-0 left-0 right-0 h-4 bg-primary-50 rounded-t-[8px] sm:hidden" />
                        <Graphsheet
                            majorCell={{
                                lineColor: [246, 248, 254, 1.0],
                                lineWidth: 2,
                                cellDim: 50,
                            }}
                            minorCell={{
                                lineColor: [255, 255, 255, 1.0],
                                lineWidth: 0,
                                cellDim: 0,
                            }}
                            className="absolute w-full h-full left-0 top-0"
                        />
                        <div className="flex items-center text-grey-10 relative mt-2 sm:mt-0">
                            <div className="text-[22px] lg:text-2xl text-grey-10 sm:flex w-full font-medium relative">
                                <Dialog.Title>
                                    Your are about to cancel your subscription
                                </Dialog.Title>
                            </div>
                            <button
                                className="ml-auto"
                                onClick={() => {
                                    handleDialogOpenChange(false);
                                }}
                            >
                                <CloseCircle className="size-6 relative text-grey-10" />
                            </button>
                        </div>

                        <div className="pt-2 grow flex flex-col relative">
                            <P size="sm" className="text-grey-70 mb-8">
                                You&apos;ll be redirected to the Stripe customer portal where you can manage your subscription. Are you sure you want to cancel your subscription?
                            </P>

                            <div className="mb-6">
                                <div className="space-y-3">
                                    <div className="space-y-3">
                                        {getPlanFeatures().map((feature, index) => (
                                            <div key={index} className="flex items-center">
                                                <div className="mr-2 p-1.5 bg-grey-90 rounded-full">
                                                    <CloseCircle className="size-6 text-grey-60" />
                                                </div>
                                                <span className="text-lg font-medium text-grey-10">{feature}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="flex gap-3">
                                <ButtonCard
                                    variant="secondary"
                                    className="flex-1"
                                    onClick={() => handleDialogOpenChange(false)}
                                    disabled={isCancelling}
                                >
                                    Stay subscribe
                                </ButtonCard>
                                <ButtonCard
                                    className="flex-1"
                                    onClick={handleCancelSubscription}
                                    loading={isCancelling}
                                >
                                    Yes cancel
                                </ButtonCard>
                            </div>
                        </div>
                    </Dialog.Content>
                </Dialog.Overlay>
            </Dialog.Portal>
        </Dialog.Root>
    );
};

export default CancelSubscriptionDialog;
