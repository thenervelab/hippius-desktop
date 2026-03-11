import { useEffect, useState, useCallback } from "react";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";

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
    const { polkadotAddress } = useWalletAuth();
    const [data, setData] = useState<TransactionObject[] | null>(null);
    const [isPending, setIsPending] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchTransactions = useCallback(async () => {
        if (!polkadotAddress) {
            setData([]);
            setError("Not authenticated");
            setIsPending(false);
            return;
        }

        try {
            setIsPending(true);
            setError(null);
            setData(null);

            const json = await invoke<BillingTransactionsResponse>("get_billing_transactions", {
                accountId: polkadotAddress,
            });

            const mapped: TransactionObject[] = (json.results || []).map((t) => ({
                id: t.id,
                transaction_type: t.payment_type.toLowerCase().includes('stripe') ? 'card' : 'tao',
                amount: typeof t.amount === "string" ? parseFloat(t.amount) : Number(t.amount ?? 0),
                transaction_date: t.created_at,
                status: t.status,
            }));

            setData(mapped);
        } catch (e: unknown) {
            setData([]);
            setError(e instanceof Error ? e.message : "Unknown error");
        } finally {
            setIsPending(false);
        }
    }, [polkadotAddress]);

    useEffect(() => {
        if (polkadotAddress) {
            fetchTransactions();
        }
    }, [polkadotAddress, fetchTransactions]);

    return { data, isPending, error, refetch: fetchTransactions };
}
