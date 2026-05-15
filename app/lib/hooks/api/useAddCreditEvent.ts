import { keepPreviousData, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import { LIVE_DATA_REFRESH_MS } from "@/lib/constants";
import { useInvokeQuery } from "./useInvokeQuery";

export interface CreditEventObject {
  id: number;
  blockNumber: number;
  amount: string;
  accountId: string;
  timestamp: string;
  hash: string;
}

export interface UseCreditEventParams {
  page?: number;
  limit?: number;
}

export default function useAddCreditEvent(
  params?: UseCreditEventParams,
  options?: Omit<UseQueryOptions<CreditEventObject[], Error, CreditEventObject[]>, "queryKey" | "queryFn">
): UseQueryResult<CreditEventObject[], Error> {
  const page = params?.page || 1;
  const limit = params?.limit || 10;

  return useInvokeQuery<CreditEventObject[], CreditEventObject[]>({
    command: "get_add_credit_events",
    queryKey: (addr) => ["creditEvents", addr, page, limit],
    params: (polkadotAddress) => ({
      accountId: polkadotAddress,
      page,
      limit,
    }),
    options: {
      // Add-credit events land one per block; poll at block cadence and
      // keep polling when the window is backgrounded so a top-up made
      // elsewhere shows up without refocusing the app.
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchInterval: LIVE_DATA_REFRESH_MS,
      refetchIntervalInBackground: true,
      placeholderData: keepPreviousData,
      ...options,
    },
  });
}
