"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { SUPPORT_CONFIG } from "@/lib/config";
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
  const { oauthSession } = useWalletAuth();

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
      oauthSession?.token,
    ],
    queryFn: async () => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      if (!ticket_id) {
        throw new Error("Ticket ID is required");
      }

      // Build query string
      const queryParams = new URLSearchParams();
      if (search) queryParams.append("search", search);
      if (ordering) queryParams.append("ordering", ordering);
      if (page) queryParams.append("page", String(page));
      if (limit) queryParams.append("limit", String(limit));

      // Direct API call
      const url = `${SUPPORT_CONFIG.baseUrl}/tickets/${ticket_id}/messages/${
        queryParams.toString() ? `?${queryParams.toString()}` : ""
      }`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: Failed to fetch ticket messages`
        );
      }

      return response.json() as Promise<SupportTicketMessagesResponse>;
    },
    enabled: !!oauthSession?.token && !!ticket_id,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    staleTime: 1 * 60 * 1000, // 1 minute (shorter than tickets since messages update more frequently)
    ...options,
  });
}
