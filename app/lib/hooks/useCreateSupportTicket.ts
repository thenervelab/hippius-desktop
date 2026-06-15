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

// Request payload for creating a ticket
export interface CreateTicketPayload {
  subject: string;
  priority: "low" | "normal" | "high" | "urgent";
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
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<SupportTicket, Error, CreateTicketPayload>({
    mutationFn: async (payload: CreateTicketPayload) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<SupportTicket>("create_support_ticket", {
        accountId: polkadotAddress,
        params: payload,
      });
    },
    onSuccess: () => {
      // Invalidate and refetch support tickets list
      queryClient.invalidateQueries({ queryKey: ["supportTickets"] });
    },
    ...options,
  });
}
