import { keepPreviousData } from "@tanstack/react-query";
import { ChartPoint } from "@/lib/types/chartTypes";
import { useInvokeQuery } from "./useInvokeQuery";

export const CREDIT_BALANCE_CHART_QUERY_KEY = "credit-balance-chart";

export type CreditBalanceRange =
  | "last7days"
  | "last30days"
  | "last60days"
  | "year"
  | "max";

/**
 * Available-credit balance over time — the series that belongs under the
 * "Available Credits" headline, because it *is* that headline's value at each
 * point in the past.
 *
 * Not to be confused with `useDriveCreditsChart`, which is cumulative Drive
 * *spend* (a rising curve) and backs the Billing page's "Drive Credit Usage"
 * card.
 */
export function useCreditBalanceChart(range: CreditBalanceRange) {
  return useInvokeQuery<ChartPoint[]>({
    command: "get_credit_balance_chart",
    queryKey: (addr) => [CREDIT_BALANCE_CHART_QUERY_KEY, addr, range],
    params: (addr) => ({ accountId: addr, range }),
    options: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Keep the prior series across a refetch / range switch so the chart
      // never renders its empty fallback mid-refresh — pairs with the
      // component's animKey guard against the periodic re-grow flash (F-8).
      placeholderData: keepPreviousData,
    },
  });
}
