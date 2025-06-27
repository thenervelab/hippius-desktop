import { useState, useEffect } from "react";
// import { authService } from "@/lib/services/auth-service";

export interface SubscriptionPlan {
  id: string;
  name: string;
  description: string | null;
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

const dummyPlansApiResponse = {
  plans: [
    {
      id: "prod_SYtFxmpsG2PGpy",
      name: "Plan1",
      description: null,
      price_id: "price_1RdlSyLwzPfzXVTcHNPphtAP",
      currency: "usd",
      amount: 10,
      interval: "month",
      interval_count: 1,
      credits_per_billing: 10,
      savings_vs_onetime: {
        annual_subscription_cost: 120,
        annual_onetime_cost: 120,
        convenience_benefit: "Automatic reloading, never run out of credits",
      },
    },
    {
      id: "prod_SYtFy84bzQH1Cs",
      name: "plan 2",
      description: null,
      price_id: "price_1RdlTHLwzPfzXVTcBB54QwXO",
      currency: "usd",
      amount: 20,
      interval: "month",
      interval_count: 1,
      credits_per_billing: 20,
      savings_vs_onetime: {
        annual_subscription_cost: 240,
        annual_onetime_cost: 240,
        convenience_benefit: "Automatic reloading, never run out of credits",
      },
    },
  ],
  recommendation:
    "Subscriptions offer automatic credit reloading and better value than one-time purchases.",
};
const dummyActiveApiResponse = {
  subscription: {
    id: "sub_1RdxwvLwzPfzXVTc4K1ysG4I",
    status: "active",
    plan_name: "plan 2",
    amount: 20,
    currency: "usd",
    interval: "month",
    current_period_start: "2025-06-25T18:21:33+00:00",
    current_period_end: "2025-07-25T18:21:33+00:00",
    cancel_at_period_end: true,
    credits_per_billing: 20,
  },
  has_subscription: true,
};

export default function useSubscriptionData() {
  const [activeSubscription, setActiveSubscription] =
    useState<ActiveSubscription | null>(null);
  const [subscriptionPlans, setSubscriptionPlans] = useState<
    SubscriptionPlan[]
  >([]);
  const [recommendation, setRecommendation] = useState<string>("");
  const [isLoadingActive, setIsLoadingActive] = useState(true);
  const [isLoadingPlans, setIsLoadingPlans] = useState(true);
  const [activeError, setActiveError] = useState<string | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);

  useEffect(() => {
    fetchActiveSubscription();
    fetchSubscriptionPlans();
  }, []);

  const fetchActiveSubscription = async () => {
    try {
      setIsLoadingActive(true);
      // const authToken = authService.getAuthToken();

      // if (!authToken) {
      //     throw new Error("Not authenticated");
      // }

      // const response = await fetch("https://api.hippius.com/api/billing/stripe/active-subscription/", {
      //     headers: {
      //         Authorization: `Token ${authToken}`,
      //         Accept: "application/json",
      //     },
      // });

      // if (!response.ok) {
      //     throw new Error(`Failed to fetch active subscription: ${response.status}`);
      // }

      // const data: ActiveSubscription = await response.json();
      const data = dummyActiveApiResponse;
      setActiveSubscription(data);
      setActiveError(null);
    } catch (error) {
      console.error("Error fetching active subscription:", error);
      setActiveError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setIsLoadingActive(false);
    }
  };

  const fetchSubscriptionPlans = async () => {
    try {
      setIsLoadingPlans(true);
      // const authToken = authService.getAuthToken();

      // if (!authToken) {
      //     throw new Error("Not authenticated");
      // }

      // const response = await fetch("https://api.hippius.com/api/billing/stripe/subscription-plans/", {
      //     headers: {
      //         Authorization: `Token ${authToken}`,
      //         Accept: "application/json",
      //     },
      // });

      // if (!response.ok) {
      //     throw new Error(`Failed to fetch subscription plans: ${response.status}`);
      // }

      // const data: SubscriptionPlansResponse = await response.json();

      const data = dummyPlansApiResponse;
      setSubscriptionPlans(data.plans || []);
      setRecommendation(data.recommendation || "");
      setPlansError(null);
    } catch (error) {
      console.error("Error fetching subscription plans:", error);
      setPlansError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setIsLoadingPlans(false);
    }
  };

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
