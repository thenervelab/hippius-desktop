import { keepPreviousData, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

export interface BalanceObject {
  accountId: string;
  blockNumber: number;
  freeBalance: string;
  totalBalance: string;
  timestamp: string;
}

export interface UseBalanceParams {
  page?: number;
  limit?: number;
}

export default function useSystemBalance(
  params?: UseBalanceParams,
  options?: Omit<UseQueryOptions<BalanceObject[], Error, BalanceObject[]>, "queryKey" | "queryFn">
): UseQueryResult<BalanceObject[], Error> {
  const page = params?.page ?? 1;
  const limit = params?.limit ?? 20000;

  return useInvokeQuery<BalanceObject[], BalanceObject[]>({
    command: "get_system_balance_ui",
    queryKey: (addr) => ["balance-daily", addr, page, limit],
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
