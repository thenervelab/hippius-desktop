import {
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

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
  const page = params?.page || 1;
  const limit = params?.limit || 10;

  return useInvokeQuery<CreditEventsResponse, CreditEventObject[]>({
    command: "get_add_credit_events",
    queryKey: (addr) => ["creditEvents", addr, page, limit],
    params: (polkadotAddress) => ({
      accountId: polkadotAddress,
      page,
      limit,
    }),
    options: {
      refetchInterval: 30000,
      refetchIntervalInBackground: true,
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
      ...options,
    },
  });
}
