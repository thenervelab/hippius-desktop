"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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
  // "medium" is retained for tickets created before the Low/Normal/High/Urgent
  // taxonomy shipped — the badge and inline color map both still render it.
  priority: "low" | "medium" | "normal" | "high" | "urgent";
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
  const { polkadotAddress } = useWalletAuth();

  const { page = 1, limit = 10, search = "" } = params || {};

  return useQuery<SupportTicketsResponse, Error, SupportTicketsResponse>({
    queryKey: ["supportTickets", page, limit, search, polkadotAddress],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<SupportTicketsResponse>("list_support_tickets", {
        accountId: polkadotAddress,
        page,
        limit,
        search: search || null,
      });
    },
    enabled: !!polkadotAddress,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}
