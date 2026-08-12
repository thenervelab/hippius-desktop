import { keepPreviousData } from "@tanstack/react-query";
import { ChartPoint } from "@/lib/types/chartTypes";
import { useInvokeQuery } from "./useInvokeQuery";

export type StorageRange =
  | "last7days"
  | "last30days"
  | "last60days"
  | "year"
  | "max";

export const DRIVE_STORAGE_CHART_QUERY_KEY = "drive-storage-chart";

export function useDriveStorageChart(range: StorageRange) {
  return useInvokeQuery<ChartPoint[]>({
    command: "get_drive_storage_chart",
    queryKey: (addr) => [DRIVE_STORAGE_CHART_QUERY_KEY, addr, range],
    params: (addr) => ({ accountId: addr, range }),
    options: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Keep the prior series on a refetch / range switch so the chart never
      // renders the empty fallback mid-refresh — the other half of the F-8
      // flash fix (the component animKey guard handles a genuine empty result).
      placeholderData: keepPreviousData,
    },
  });
}
