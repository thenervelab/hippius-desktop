import { useState, useEffect, useCallback } from "react";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { API_CONFIG } from "@/lib/config";

export interface SubscriptionPlan {
    id: string;
    name: string;
    description: string;
    price_id: string;
    currency: string;
    amount: number;
    interval: string;
    interval_count: number;
    credits_per_billing: number;
    storage_limit?: string;
    popular?: boolean;
    features?: string[];
    savings_vs_onetime?: {
        annual_subscription_cost: number;
        annual_onetime_cost: number;
        convenience_benefit?: string;
    };
}

export interface ActiveSubscription {
    subscription: {
        id: string;
        status: string;
        plan_name: string;
        amount: number;
        currency: string;
        interval: string;
        current_period_start: string;
        current_period_end: string;
        credits_per_billing: number;
        storage_limit?: string;
        cancel_at_period_end: boolean;
    };
    has_subscription: boolean;
    message?: string;
}

export interface SubscriptionPlansResponse {
    plans: SubscriptionPlan[];
    recommendation: string;
}

export default function useSubscriptionData() {
    const { oauthSession } = useWalletAuth();
    const [activeSubscription, setActiveSubscription] = useState<ActiveSubscription | null>(null);
    const [subscriptionPlans, setSubscriptionPlans] = useState<SubscriptionPlan[]>([]);
    const [recommendation, setRecommendation] = useState<string>("");
    const [isLoadingActive, setIsLoadingActive] = useState(true);
    const [isLoadingPlans, setIsLoadingPlans] = useState(true);
    const [activeError, setActiveError] = useState<string | null>(null);
    const [plansError, setPlansError] = useState<string | null>(null);

    const fetchActiveSubscription = useCallback(async () => {
        if (!oauthSession?.token) {
            setActiveError("Not authenticated");
            setIsLoadingActive(false);
            return;
        }

        try {
            setIsLoadingActive(true);
            setActiveError(null);

            const response = await fetch(
                `${API_CONFIG.baseUrl}${API_CONFIG.billing.activeSubscription}`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `Token ${oauthSession.token}`,
                        Accept: "application/json",
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch active subscription: ${response.status}`);
            }

            const data: ActiveSubscription = await response.json();
            setActiveSubscription(data);
        } catch (error) {
            console.error("Error fetching active subscription:", error);
            setActiveError(error instanceof Error ? error.message : "Unknown error");
        } finally {
            setIsLoadingActive(false);
        }
    }, [oauthSession?.token]);

    const fetchSubscriptionPlans = useCallback(async () => {
        if (!oauthSession?.token) {
            setPlansError("Not authenticated");
            setIsLoadingPlans(false);
            return;
        }

        try {
            setIsLoadingPlans(true);
            setPlansError(null);

            const response = await fetch(
                `${API_CONFIG.baseUrl}${API_CONFIG.billing.subscriptionPlans}`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `Token ${oauthSession.token}`,
                        Accept: "application/json",
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch subscription plans: ${response.status}`);
            }

            const data: SubscriptionPlansResponse = await response.json();
            setSubscriptionPlans(data.plans || []);
            setRecommendation(data.recommendation || "");
        } catch (error) {
            console.error("Error fetching subscription plans:", error);
            setPlansError(error instanceof Error ? error.message : "Unknown error");
        } finally {
            setIsLoadingPlans(false);
        }
    }, [oauthSession?.token]);

    useEffect(() => {
        if (oauthSession?.token) {
            fetchActiveSubscription();
            fetchSubscriptionPlans();
        }
    }, [oauthSession?.token, fetchActiveSubscription, fetchSubscriptionPlans]);

    return {
        activeSubscription,
        subscriptionPlans,
        recommendation,
        isLoadingActive,
        isLoadingPlans,
        isLoading: isLoadingActive || isLoadingPlans,
        activeError,
        plansError,
        refetchActiveSubscription: fetchActiveSubscription,
        refetchSubscriptionPlans: fetchSubscriptionPlans,
    };
}
