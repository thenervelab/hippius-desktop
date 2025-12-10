"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { SUPPORT_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { SupportTicket } from "./useSupportTickets";

// Request payload for creating a ticket
export interface CreateTicketPayload {
  subject: string;
  priority: "low" | "medium" | "high";
  category: string;
  resource_type: string;
  resource_id: string;
  description: string;
}

/**
 * Hook to create a new support ticket using react-query mutation
 */
export default function useCreateSupportTicket(
  options?: Omit<
    UseMutationOptions<SupportTicket, Error, CreateTicketPayload>,
    "mutationFn"
  >
): UseMutationResult<SupportTicket, Error, CreateTicketPayload> {
  const { oauthSession } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<SupportTicket, Error, CreateTicketPayload>({
    mutationFn: async (payload: CreateTicketPayload) => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      // Direct API call
      const url = `${SUPPORT_CONFIG.baseUrl}${SUPPORT_CONFIG.endpoints.list}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.message ||
            `HTTP ${response.status}: Failed to create support ticket`
        );
      }

      return response.json() as Promise<SupportTicket>;
    },
    onSuccess: () => {
      // Invalidate and refetch support tickets list
      queryClient.invalidateQueries({ queryKey: ["supportTickets"] });
    },
    ...options,
  });
}
