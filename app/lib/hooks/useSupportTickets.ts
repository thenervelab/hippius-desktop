"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { SUPPORT_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface TicketMessage {
  id: number;
  author: number;
  author_is_staff: boolean;
  author_is_requester: boolean;
  author_display: string;
  message_type: "public" | "private";
  body: string;
  created_at: string;
  attachments: Array<{
    id: number;
    filename: string;
    file: string;
    uploaded_at: string;
  }>;
}

export interface SupportTicket {
  id: number;
  subject: string;
  status: "open" | "closed" | "in_progress" | "resolved";
  priority: "low" | "medium" | "high";
  category: string;
  resource_type: string;
  resource_id: string;
  created_by: number;
  assigned_to: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  last_user_reply_at?: string;
  last_staff_reply_at?: string;
  last_message_at?: string;
  messages?: TicketMessage[];
}

export interface SupportTicketsResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: SupportTicket[];
}

export interface UseSupportTicketsParams {
  page?: number;
  limit?: number;
  search?: string;
}

/**
 * Hook to fetch support tickets using react-query
 */
export default function useSupportTickets(
  params?: UseSupportTicketsParams,
  options?: Omit<
    UseQueryOptions<SupportTicketsResponse, Error, SupportTicketsResponse>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<SupportTicketsResponse, Error> {
  const { oauthSession } = useWalletAuth();

  const { page = 1, limit = 10, search = "" } = params || {};

  return useQuery<SupportTicketsResponse, Error, SupportTicketsResponse>({
    queryKey: ["supportTickets", page, limit, search, oauthSession?.token],
    queryFn: async () => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      // Build query string
      const queryParams = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });

      // Add search parameter if provided
      if (search) {
        queryParams.append("search", search);
      }

      // Direct API call
      const url = `${SUPPORT_CONFIG.baseUrl}${
        SUPPORT_CONFIG.endpoints.list
      }?${queryParams.toString()}&ordering=status`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: Failed to fetch support tickets`
        );
      }

      return response.json() as Promise<SupportTicketsResponse>;
    },
    enabled: !!oauthSession?.token,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}
