import { keepPreviousData, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

export interface CreditObject {
  id: string;
  block: number;
  amount: string;
  accountId: string;
  date: string;
}

export interface UseCreditsParams {
  page?: number;
  limit?: number;
}

export default function useCredits(
  params?: UseCreditsParams,
  options?: Omit<UseQueryOptions<CreditObject[], Error, CreditObject[]>, "queryKey" | "queryFn">
): UseQueryResult<CreditObject[], Error> {
  const page = params?.page || 1;
  const limit = params?.limit || 100000;

  return useInvokeQuery<CreditObject[], CreditObject[]>({
    command: "get_credits",
    queryKey: (addr) => ["credits", addr, page, limit],
    params: (polkadotAddress) => ({
      accountId: polkadotAddress,
      page,
      limit,
    }),
    options: {
      placeholderData: keepPreviousData,
      ...options,
    },
  });
}
