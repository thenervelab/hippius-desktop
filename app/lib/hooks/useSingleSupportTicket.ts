"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { SUPPORT_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { SupportTicket } from "./useSupportTickets";

/**
 * Hook to fetch a single support ticket detail using react-query
 */
export default function useSingleSupportTicket(
  ticketId: string | number,
  options?: Omit<
    UseQueryOptions<SupportTicket, Error, SupportTicket>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<SupportTicket, Error> {
  const { oauthSession } = useWalletAuth();

  return useQuery<SupportTicket, Error, SupportTicket>({
    queryKey: ["supportTicket", ticketId.toString(), oauthSession?.token],
    queryFn: async () => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      // API endpoint: /support/tickets/{id}/
      const url = `${SUPPORT_CONFIG.baseUrl}${SUPPORT_CONFIG.endpoints.list}${ticketId}/`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: Failed to fetch support ticket detail`
        );
      }

      return response.json() as Promise<SupportTicket>;
    },
    enabled: !!oauthSession?.token && !!ticketId,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}
