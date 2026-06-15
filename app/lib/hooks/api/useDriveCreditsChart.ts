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
    },
  });
}
