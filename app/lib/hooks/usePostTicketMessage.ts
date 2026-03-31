"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<TicketMessage, Error, PostTicketMessagePayload>({
    mutationFn: async (payload: PostTicketMessagePayload) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const { ticket_id, message_type, body } = payload;

      return invoke<TicketMessage>("post_ticket_message", {
        accountId: polkadotAddress,
        ticketId: parseInt(ticket_id, 10),
        messageType: message_type,
        body,
      });
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["supportTicketMessages", variables.ticket_id],
      });
      queryClient.invalidateQueries({
        queryKey: ["supportTicket", variables.ticket_id],
      });
    },
    ...options,
  });
}
