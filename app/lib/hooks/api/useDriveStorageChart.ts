import { ChartPoint } from "@/lib/types/chartTypes";
import { useInvokeQuery } from "./useInvokeQuery";
import { StorageRange } from "@/app/components/page-sections/home/storage-usage-bars/storageDeltaUtils";

export const DRIVE_STORAGE_CHART_QUERY_KEY = "drive-storage-chart";

export function useDriveStorageChart(range: StorageRange) {
  return useInvokeQuery<ChartPoint[]>({
    command: "get_drive_storage_chart",
    queryKey: (addr) => [DRIVE_STORAGE_CHART_QUERY_KEY, addr, range],
    params: (addr) => ({ accountId: addr, range }),
    options: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  });
}
