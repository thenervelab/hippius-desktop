import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { API_BASE_URL } from "../../constants";

// Define types based on the indexer API response
export interface TransferEvent {
  block_number: number;
  event_index: number;
  from_account: string;
  to_account: string;
  amount: string;
  extrinsic_hash: string | null;
  raw_event_data: {
    amount: string;
    from: string;
    to: string;
  };
  processed_timestamp: string;
}

export interface TransfersResponse {
  data: TransferEvent[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

// Modified structure to match new column requirements
export interface TransactionObject {
  id: string;
  block: number;
  amount: number;
  from: string;
  date: string;
}

export interface UseTransfersParams {
  page?: number;
  limit?: number;
}

export default function useBillingTransactions(
  params?: UseTransfersParams,
  options?: Omit<
    UseQueryOptions<TransfersResponse, Error, TransactionObject[]>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<TransactionObject[], Error> {
  const { polkadotAddress } = useWalletAuth();
  const page = params?.page || 1;
  const limit = params?.limit || 10;

  return useQuery<TransfersResponse, Error, TransactionObject[]>({
    queryKey: ["transfers", polkadotAddress, page, limit],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const url = `${API_BASE_URL}/balance-transfers?account=${polkadotAddress}`;

      const response = await fetch(url, {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch transfers: ${response.status}`);
      }

      return (await response.json()) as TransfersResponse;
    },
    select: (data) => {
      return data.data.map((transfer) => ({
        id: `${transfer.block_number}-${transfer.event_index}`,
        block: transfer.block_number,
        amount: parseFloat(transfer.amount),
        from: transfer.from_account,
        date: transfer.processed_timestamp,
      }));
    },
    placeholderData: keepPreviousData,
    enabled: !!polkadotAddress,
    ...options,
  });
}
