import { useInvokeQuery } from "./useInvokeQuery";
import type { DrivePlan } from "@/lib/types/drive-plans";

export const DRIVE_PLANS_QUERY_KEY = "drive-plans";

/** The plan catalogue. Public, and it changes about as often as pricing does. */
export default function useDrivePlans() {
  return useInvokeQuery<DrivePlan[] | { results: DrivePlan[] }, DrivePlan[]>({
    command: "get_drive_plans",
    queryKey: (addr) => [DRIVE_PLANS_QUERY_KEY, addr],
    options: {
      select: (data) => (Array.isArray(data) ? data : data.results),
      staleTime: 5 * 60 * 1000,
    },
  });
}
