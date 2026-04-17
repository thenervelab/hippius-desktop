import { keepPreviousData, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

export interface TransactionObject {
  id: string;
  block: number;
  /** Raw planck amount as a decimal-digit string (full precision). */
  amountPlanck: string;
  /** Pre-formatted HIP display string (`planck_to_hip` in Rust). */
  amountHip: string;
  from: string;
  to: string;
  date: string;
  direction: string;
}

export interface UseBalanceTransfersParams {
  page?: number;
  limit?: number;
}

export default function useBalanceTransactions(
  params?: UseBalanceTransfersParams,
  options?: Omit<UseQueryOptions<TransactionObject[], Error, TransactionObject[]>, "queryKey" | "queryFn">
): UseQueryResult<TransactionObject[], Error> {
  const page = params?.page || 1;
  const limit = params?.limit || 10;

  return useInvokeQuery<TransactionObject[], TransactionObject[]>({
    command: "get_balance_transfers",
    queryKey: (addr) => ["transfers", addr, page, limit],
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
