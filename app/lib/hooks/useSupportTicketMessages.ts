"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { TicketMessage } from "./useSupportTickets";

export interface SupportTicketMessagesResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: TicketMessage[];
}

export interface UseSupportTicketMessagesParams {
  ticket_id: string | number;
  search?: string;
  ordering?: string;
  page?: number;
  limit?: number;
}

/**
 * Hook to fetch support ticket messages using react-query
 */
export default function useSupportTicketMessages(
  params: UseSupportTicketMessagesParams,
  options?: Omit<
    UseQueryOptions<
      SupportTicketMessagesResponse,
      Error,
      SupportTicketMessagesResponse
    >,
    "queryKey" | "queryFn"
  >
): UseQueryResult<SupportTicketMessagesResponse, Error> {
  const { polkadotAddress } = useWalletAuth();

  const { ticket_id, search, ordering, page = 1, limit = 10 } = params || {};

  return useQuery<
    SupportTicketMessagesResponse,
    Error,
    SupportTicketMessagesResponse
  >({
    queryKey: [
      "supportTicketMessages",
      ticket_id,
      search,
      ordering,
      page,
      limit,
      polkadotAddress,
    ],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      if (!ticket_id) {
        throw new Error("Ticket ID is required");
      }

      return invoke<SupportTicketMessagesResponse>(
        "get_support_ticket_messages",
        {
          accountId: polkadotAddress,
          ticketId: typeof ticket_id === "string" ? parseInt(ticket_id, 10) : ticket_id,
          page,
          limit,
          search: search || null,
          ordering: ordering || null,
        }
      );
    },
    enabled: !!polkadotAddress && !!ticket_id,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    staleTime: 1 * 60 * 1000,
    ...options,
  });
}
