import { useEffect, useState, useCallback } from "react";
import { API_CONFIG, getAuthHeaders } from "@/app/lib/helpers/sessionStore";
import { ensureBillingAuth } from "./useBillingAuth";

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
    const [data, setData] = useState<TransactionObject[] | null>(null);
    const [isPending, setIsPending] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchTransactions = useCallback(async () => {
        try {
            setIsPending(true);
            setError(null);
            setData(null);

            const authOk = await ensureBillingAuth();
            if (!authOk.ok) {
                setData([]);
                setError(authOk.error || "Not authenticated");
                return;
            }

            const headers = await getAuthHeaders();
            if (!headers) {
                setData([]);
                setError("Not authenticated");
                return;
            }

            const url = `${API_CONFIG.baseUrl}${API_CONFIG.billing.transactions}`;
            const res = await fetch(url, { method: "GET", headers });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Failed to fetch billing transactions: ${res.status} ${text}`);
            }

            const json: BillingTransactionsResponse = await res.json();
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
    }, []);

    useEffect(() => {
        fetchTransactions();
    }, [fetchTransactions]);

    return { data, isPending, error, refetch: fetchTransactions };
}
