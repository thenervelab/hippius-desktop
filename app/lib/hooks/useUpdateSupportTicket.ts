"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { SupportTicket } from "./useSupportTickets";

// Request payload for updating a ticket (partial update)
export interface UpdateTicketPayload {
  id: number;
  status?: "open" | "pending" | "resolved" | "closed";
  priority?: "low" | "normal" | "high" | "urgent";
  assigned_to?: number | null;
}

/**
 * Hook to update a support ticket using react-query mutation (PATCH)
 */
export default function useUpdateSupportTicket(
  options?: Omit<
    UseMutationOptions<SupportTicket, Error, UpdateTicketPayload>,
    "mutationFn"
  >
): UseMutationResult<SupportTicket, Error, UpdateTicketPayload> {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<SupportTicket, Error, UpdateTicketPayload>({
    mutationFn: async (payload: UpdateTicketPayload) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const { id, ...updateData } = payload;

      return invoke<SupportTicket>("update_support_ticket", {
        accountId: polkadotAddress,
        ticketId: id,
        updates: updateData,
      });
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["supportTickets"] });
      queryClient.invalidateQueries({
        queryKey: ["supportTicket", variables.id.toString()],
      });
    },
    ...options,
  });
}
