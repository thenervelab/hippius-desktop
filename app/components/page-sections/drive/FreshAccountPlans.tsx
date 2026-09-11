"use client";

import React from "react";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import SubscriptionPlansSection from "@/components/page-sections/billing/SubscriptionPlansSection";

import { shouldShowFreshAccountPlans } from "./freshAccountPlansState";

/**
 * The plan catalogue, under the Drive page's empty state, for an account
 * that has neither a folder nor a plan.
 *
 * The same section the billing page renders, rather than a second
 * catalogue: the plans, their prices and the subscribe flow are one thing,
 * and a copy of them here would be a copy to keep in step.
 */
const FreshAccountPlans: React.FC<{
  hasFolders: boolean;
  isLoading: boolean;
}> = ({ hasFolders, isLoading }) => {
  const { data: overview, isLoading: overviewLoading } = useStorageOverview();

  const show = shouldShowFreshAccountPlans({
    hasFolders,
    source: overview?.source,
    isLoading: isLoading || overviewLoading,
  });
  if (!show) return null;

  return <SubscriptionPlansSection />;
};

export default FreshAccountPlans;
