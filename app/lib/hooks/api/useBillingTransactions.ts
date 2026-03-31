import { useInvokeQuery } from "./useInvokeQuery";

// Define types based on the indexer API response
export interface BillingTransferEvent {
    id: number;
    transaction_type: string;
    amount: string;
    transaction_date: string;
}

export interface BillingTransfersResponse {
    data: BillingTransferEvent[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        total_pages: number;
    };
}

// Modified structure to match new column requirements
export type TransactionObject = {
    id: string | number;
    transaction_type: string;
    amount: number;
    transaction_date: string;
    status: string;
};

type BillingTransaction = {
    id: string | number;
    payment_type: string;
    amount: number | string;
    created_at: string;
    status: string;
};

type BillingTransactionsResponse = {
    results: BillingTransaction[];
    count: number;
    next: string | null;
    previous: string | null;
};

export interface UseBillingTransfersParams {
    page?: number;
    limit?: number;
}

export default function useBillingTransactions() {
    const query = useInvokeQuery<BillingTransactionsResponse, TransactionObject[]>({
        command: "get_billing_transactions",
        queryKey: (addr) => ["billing-transactions", addr],
        options: {
            select: (json) => {
                return (json.results || []).map((t) => ({
                    id: t.id,
                    transaction_type: t.payment_type.toLowerCase().includes('stripe') ? 'card' : 'tao',
                    amount: typeof t.amount === "string" ? parseFloat(t.amount) : Number(t.amount ?? 0),
                    transaction_date: t.created_at,
                    status: t.status,
                }));
            },
        },
    });

    return {
        data: query.data ?? null,
        isPending: query.isPending,
        error: query.error ? (query.error instanceof Error ? query.error.message : "Unknown error") : null,
        refetch: query.refetch,
    };
}
