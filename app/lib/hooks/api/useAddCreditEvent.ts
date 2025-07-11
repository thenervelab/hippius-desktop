import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { API_BASE_URL } from "../../constants";

// Define types based on the indexer API response for MintedAccountCredits events
export interface EventData {
  amount: string;
  who: string;
}

export interface CreditEventItem {
  id: string;
  block_number: number;
  event_index: number;
  account_id: string;
  pallet_name: string;
  event_name: string;
  event_data: EventData;
  extrinsic_hash: string;
  processed_timestamp: string;
}

export interface CreditEventsResponse {
  events: CreditEventItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

// Modified structure for UI consumption
export interface CreditEventObject {
  id: string;
  blockNumber: number;
  amount: string;
  accountId: string;
  timestamp: string;
  hash: string;
}

export interface UseAddCreditEventParams {
  page?: number;
  limit?: number;
}

export default function useAddCreditEvent(
  params?: UseAddCreditEventParams,
  options?: Omit<
    UseQueryOptions<CreditEventsResponse, Error, CreditEventObject[]>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<CreditEventObject[], Error> {
  const { polkadotAddress } = useWalletAuth();
  const page = params?.page || 1;
  const limit = params?.limit || 10;

  return useQuery<CreditEventsResponse, Error, CreditEventObject[]>({
    queryKey: ["creditEvents", polkadotAddress, page, limit],
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const url = `${API_BASE_URL}/events?event_name=MintedAccountCredits&account_id=${polkadotAddress}&page=${page}&limit=${limit}`;

      const response = await fetch(url, {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch credit events: ${response.status}`);
      }

      return (await response.json()) as CreditEventsResponse;
    },
    select: (data) => {
      return data.events.map((event) => ({
        id: event.id,
        blockNumber: event.block_number,
        amount: event.event_data.amount,
        accountId: event.account_id,
        timestamp: event.processed_timestamp,
        hash: event.extrinsic_hash,
      }));
    },
    placeholderData: keepPreviousData,
    enabled: !!polkadotAddress,
    ...options,
  });
}
