import {
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

// Define types based on the indexer API response
export interface MarketplaceCreditEvent {
  block_number: number;
  event_index: number;
  account_id: string;
  event_name: string;
  credits_amount: string;
  transaction_type?: string;
  raw_event_data: {
    amount?: string;
    transactionType?: string;
    credits?: string;
    owner?: string;
  };
  processed_timestamp: string;
}

export interface MarketplaceCreditsResponse {
  events: MarketplaceCreditEvent[];
}

// Modified structure for UI consumption
export interface MarketplaceCreditObject {
  blockNumber: number;
  eventIndex: number;
  eventName: string;
  amount: string;
  accountId: string;
  transactionType: string | null;
  date: string;
}

export interface UseMarketplaceCreditsParams {
  page?: number;
  limit?: number;
}

export default function useMarketplaceCredits(
  params?: UseMarketplaceCreditsParams,
  options?: Omit<
    UseQueryOptions<
      MarketplaceCreditsResponse,
      Error,
      MarketplaceCreditObject[]
    >,
    "queryKey" | "queryFn"
  >
): UseQueryResult<MarketplaceCreditObject[], Error> {
  const page = params?.page || 1;
  const limit = params?.limit || 100000;

  return useInvokeQuery<MarketplaceCreditsResponse, MarketplaceCreditObject[]>({
    command: "get_marketplace_credits",
    queryKey: (addr) => ["marketplace-credits", addr, page, limit],
    params: (polkadotAddress) => ({
      accountId: polkadotAddress,
      page,
      limit,
    }),
    options: {
      select: (data) => {
        return data.events.map((event) => ({
          blockNumber: event.block_number,
          eventIndex: event.event_index,
          eventName: event.event_name,
          amount: event.credits_amount,
          accountId: event.account_id,
          transactionType: event.transaction_type || null,
          date: event.processed_timestamp,
        }));
      },
      placeholderData: keepPreviousData,
      ...options,
    },
  });
}
