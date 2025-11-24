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

// Request payload for updating a ticket (partial update)
export interface UpdateTicketPayload {
  id: number;
  status?: "open" | "closed" | "in_progress";
  priority?: "low" | "medium" | "high";
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
  const { oauthSession } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<SupportTicket, Error, UpdateTicketPayload>({
    mutationFn: async (payload: UpdateTicketPayload) => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const { id, ...updateData } = payload;

      // API endpoint: /support/tickets/{id}/
      const url = `${SUPPORT_CONFIG.baseUrl}${SUPPORT_CONFIG.endpoints.list}${id}/`;

      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updateData),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.message ||
            `HTTP ${response.status}: Failed to update support ticket`
        );
      }

      return response.json() as Promise<SupportTicket>;
    },
    onSuccess: (data, variables) => {
      // Invalidate and refetch support tickets list
      queryClient.invalidateQueries({ queryKey: ["supportTickets"] });
      // Also invalidate the specific ticket query if it exists
      queryClient.invalidateQueries({
        queryKey: ["supportTicket", variables.id.toString()],
      });
    },
    ...options,
  });
}
