import { keepPreviousData, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
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
    command: "get_add_credit_events_ui",
    queryKey: (addr) => ["creditEvents", addr, page, limit],
    params: (polkadotAddress) => ({
      accountId: polkadotAddress,
      page,
      limit,
    }),
    options: {
      refetchInterval: 30000,
      refetchIntervalInBackground: true,
      placeholderData: keepPreviousData,
      ...options,
    },
  });
}
