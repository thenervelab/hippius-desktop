"use client";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";

import { getPlanActionView, type PlanActionView } from "./planActionView";

/**
 * What the header should offer this account, or `null` for nothing.
 *
 * {@link PlanActionButton} renders nothing when there is nothing to offer,
 * but a layout cannot see that from the outside — so every header that
 * wrapped the button in a padded cell kept drawing the cell, and a healthy
 * plan's card ended in a strip of empty space where a button used to be.
 *
 * Callers use this to drop the cell itself. It shares the query cache with
 * the button, so asking costs no extra fetch and the two cannot disagree.
 */
export function usePlanActionView(): PlanActionView | null {
  const { data: overview } = useStorageOverview();
  return getPlanActionView(overview?.planAction);
}
