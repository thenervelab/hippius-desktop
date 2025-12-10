"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { SUPPORT_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";

// Request payload for posting a message to a ticket
export interface PostTicketMessagePayload {
  ticket_id: string;
  message_type: "public" | "internal";
  body: string;
}

// Response type for a ticket message
export interface TicketMessage {
  id: number;
  author: number;
  author_display: string;
  message_type: "public" | "internal";
  body: string;
  created_at: string;
  attachments: Array<{
    id: number;
    filename: string;
    file: string;
    uploaded_at: string;
  }>;
}

/**
 * Hook to post a message to a support ticket using react-query mutation
 */
export default function usePostTicketMessage(
  options?: Omit<
    UseMutationOptions<TicketMessage, Error, PostTicketMessagePayload>,
    "mutationFn"
  >
): UseMutationResult<TicketMessage, Error, PostTicketMessagePayload> {
  const { oauthSession } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<TicketMessage, Error, PostTicketMessagePayload>({
    mutationFn: async (payload: PostTicketMessagePayload) => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const { ticket_id, ...messageData } = payload;

      // API endpoint: /support/tickets/{ticket_id}/messages/
      const url = `${SUPPORT_CONFIG.baseUrl}/tickets/${ticket_id}/messages/`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(messageData),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.message ||
            `HTTP ${response.status}: Failed to post message to ticket`
        );
      }

      return response.json() as Promise<TicketMessage>;
    },
    onSuccess: (data, variables) => {
      // Invalidate ticket messages query for this specific ticket
      queryClient.invalidateQueries({
        queryKey: ["supportTicketMessages", variables.ticket_id],
      });
      // Also invalidate the ticket details in case last_message_at updated
      queryClient.invalidateQueries({
        queryKey: ["supportTicket", variables.ticket_id],
      });
      // Don't invalidate support tickets list to avoid unnecessary table reloads
    },
    ...options,
  });
}
