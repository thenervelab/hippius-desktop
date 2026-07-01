import { keepPreviousData } from "@tanstack/react-query";
import { ChartPoint } from "@/lib/types/chartTypes";
import { useInvokeQuery } from "./useInvokeQuery";

export const DRIVE_CREDITS_CHART_QUERY_KEY = "drive-credits-chart";

export type CreditsChartRange =
  | "last7days"
  | "last30days"
  | "last60days"
  | "year"
  | "max";

export function useDriveCreditsChart(range: CreditsChartRange) {
  return useInvokeQuery<ChartPoint[]>({
    command: "get_drive_credits_chart",
    queryKey: (addr) => [DRIVE_CREDITS_CHART_QUERY_KEY, addr, range],
    params: (addr) => ({ accountId: addr, range }),
    options: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Keep the prior series on a refetch / range switch so the chart never
      // renders the empty fallback mid-refresh — pairs with the component
      // animKey guard against the periodic re-grow flash (F-8).
      placeholderData: keepPreviousData,
    },
  });
}
