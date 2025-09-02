import { useState, useEffect, useCallback } from "react";
import { getAuthHeaders } from "@/app/lib/services/authService";
import { ensureBillingAuth } from "@/app/lib/hooks/api/useBillingAuth";
import { API_CONFIG } from "@/app/lib/helpers/sessionStore";

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
    const [activeSubscription, setActiveSubscription] = useState<ActiveSubscription | null>(null);
    const [subscriptionPlans, setSubscriptionPlans] = useState<SubscriptionPlan[]>([]);
    const [recommendation, setRecommendation] = useState<string>("");
    const [isLoadingActive, setIsLoadingActive] = useState(true);
    const [isLoadingPlans, setIsLoadingPlans] = useState(true);
    const [activeError, setActiveError] = useState<string | null>(null);
    const [plansError, setPlansError] = useState<string | null>(null);

    const fetchActiveSubscription = useCallback(async () => {
        try {
            setIsLoadingActive(true);
            setActiveError(null);

            // Ensure authentication is valid
            const authOk = await ensureBillingAuth();
            if (!authOk.ok) {
                setActiveError(authOk.error || "Not authenticated");
                return;
            }

            const headers = await getAuthHeaders();
            if (!headers) {
                setActiveError("Not authenticated");
                return;
            }

            const response = await fetch(`${API_CONFIG.baseUrl}/api/billing/stripe/active-subscription/`, {
                headers
            });

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
    }, []);

    const fetchSubscriptionPlans = useCallback(async () => {
        try {
            setIsLoadingPlans(true);
            setPlansError(null);

            // Ensure authentication is valid
            const authOk = await ensureBillingAuth();
            if (!authOk.ok) {
                setPlansError(authOk.error || "Not authenticated");
                return;
            }

            const headers = await getAuthHeaders();
            if (!headers) {
                setPlansError("Not authenticated");
                return;
            }

            const response = await fetch(`${API_CONFIG.baseUrl}/api/billing/stripe/subscription-plans/`, {
                headers
            });

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
    }, []);

    useEffect(() => {
        fetchActiveSubscription();
        fetchSubscriptionPlans();
    }, [fetchActiveSubscription, fetchSubscriptionPlans]);

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
