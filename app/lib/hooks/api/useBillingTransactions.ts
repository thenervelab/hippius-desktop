import { useInvokeQuery } from "./useInvokeQuery";

export interface TransactionObject {
  id: number;
  transaction_type: string;
  amount: number;
  transaction_date: string;
  status: string;
}

export default function useBillingTransactions() {
  const query = useInvokeQuery<TransactionObject[], TransactionObject[]>({
    command: "get_billing_transactions_ui",
    queryKey: (addr) => ["billing-transactions", addr],
  });

  return {
    data: query.data ?? null,
    isPending: query.isPending,
    isLoading: query.isLoading,
    error: query.error ?? null,
  };
}
