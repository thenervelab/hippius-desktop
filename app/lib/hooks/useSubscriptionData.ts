import { useInvokeQuery } from "./api/useInvokeQuery";

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

interface SubscriptionData {
  activeSubscription: ActiveSubscription | null;
  plans: SubscriptionPlan[];
  recommendation: string;
  isOnHighestPlan: boolean;
}

export default function useSubscriptionData() {
  const query = useInvokeQuery<SubscriptionData>({
    command: "get_subscription_data",
    queryKey: (addr) => ["subscription-data", addr],
    options: {
      staleTime: 30000,
    },
  });

  return {
    activeSubscription: query.data?.activeSubscription ?? null,
    subscriptionPlans: query.data?.plans ?? [],
    recommendation: query.data?.recommendation ?? "",
    isOnHighestPlan: query.data?.isOnHighestPlan ?? false,
    isLoadingActive: query.isLoading,
    isLoadingPlans: query.isLoading,
    isLoading: query.isLoading,
    activeError: query.error?.message ?? null,
    plansError: query.error?.message ?? null,
    refetchActiveSubscription: query.refetch,
    refetchSubscriptionPlans: query.refetch,
  };
}
