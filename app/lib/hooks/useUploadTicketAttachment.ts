"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

// Request payload for uploading an attachment to a ticket message
export interface UploadTicketAttachmentPayload {
  ticket_id: string;
  message_id: string;
  file: File;
  filename?: string; // Optional filename override
}

// Response type for a ticket attachment
export interface TicketAttachment {
  id: number;
  filename: string;
  file: string;
  uploaded_at: string;
}

/**
 * Hook to upload an attachment to a ticket message using react-query mutation.
 * Note: This uses fetch() directly because Tauri invoke() cannot handle
 * multipart/form-data with browser File objects.
 */
export default function useUploadTicketAttachment(
  options?: Omit<
    UseMutationOptions<TicketAttachment, Error, UploadTicketAttachmentPayload>,
    "mutationFn"
  >
): UseMutationResult<TicketAttachment, Error, UploadTicketAttachmentPayload> {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<TicketAttachment, Error, UploadTicketAttachmentPayload>({
    mutationFn: async (payload: UploadTicketAttachmentPayload) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      // Get auth token from Rust DB
      const token = await invoke<string>("get_auth_token", {
        accountId: polkadotAddress,
      });

      const { ticket_id, message_id, file, filename } = payload;

      // API endpoint: /api/support/tickets/{ticket_id}/messages/{message_id}/attachments/
      const url = `https://api.hippius.com/api/support/tickets/${ticket_id}/messages/${message_id}/attachments/`;

      // Create FormData for multipart/form-data upload
      const formData = new FormData();
      formData.append("file", file);

      if (filename) {
        formData.append("filename", filename);
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.message ||
            `HTTP ${response.status}: Failed to upload attachment`
        );
      }

      return response.json() as Promise<TicketAttachment>;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["ticketMessages", variables.ticket_id],
      });
      queryClient.invalidateQueries({
        queryKey: ["ticketMessage", variables.ticket_id, variables.message_id],
      });
    },
    ...options,
  });
}
