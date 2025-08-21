import {
    useQuery,
    UseQueryOptions,
    UseQueryResult,
    keepPreviousData,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { API_BASE_URL } from "@/lib/constants";

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
export interface TransactionObject {
    id: number;
    transaction_type: string;
    amount: string;
    transaction_date: string;
}

export interface UseBillingTransfersParams {
    page?: number;
    limit?: number;
}

export default function useBillingTransactions(
    params?: UseBillingTransfersParams,
    options?: Omit<
        UseQueryOptions<BillingTransfersResponse, Error, TransactionObject[]>,
        "queryKey" | "queryFn"
    >
): UseQueryResult<TransactionObject[], Error> {
    const { polkadotAddress } = useWalletAuth();
    const page = params?.page || 1;
    const limit = params?.limit || 10;

    return useQuery<BillingTransfersResponse, Error, TransactionObject[]>({
        queryKey: ["billing-transfers", polkadotAddress, page, limit],
        queryFn: async () => {
            if (!polkadotAddress) {
                throw new Error("No wallet address available");
            }

            const url = `${API_BASE_URL}/billing-transfers?account=${polkadotAddress}`;

            const response = await fetch(url, {
                headers: {
                    accept: "application/json",
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch transfers: ${response.status}`);
            }

            return (await response.json()) as BillingTransfersResponse;
        },
        select: (data) => {
            return data.data.map((transfer) => ({
                id: transfer.id,
                amount: transfer.amount,
                transaction_date: transfer.transaction_date,
                transaction_type: transfer.transaction_type
            }));
        },
        placeholderData: keepPreviousData,
        enabled: !!polkadotAddress,
        ...options,
    });
}
