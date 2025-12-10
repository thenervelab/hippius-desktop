"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { SUPPORT_CONFIG } from "@/lib/config";
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
 * Hook to upload an attachment to a ticket message using react-query mutation
 */
export default function useUploadTicketAttachment(
  options?: Omit<
    UseMutationOptions<TicketAttachment, Error, UploadTicketAttachmentPayload>,
    "mutationFn"
  >
): UseMutationResult<TicketAttachment, Error, UploadTicketAttachmentPayload> {
  const { oauthSession } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<TicketAttachment, Error, UploadTicketAttachmentPayload>({
    mutationFn: async (payload: UploadTicketAttachmentPayload) => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const { ticket_id, message_id, file, filename } = payload;

      // API endpoint: /support/tickets/{ticket_id}/messages/{message_id}/attachments/
      const url = `${SUPPORT_CONFIG.baseUrl}/tickets/${ticket_id}/messages/${message_id}/attachments/`;

      // Create FormData for multipart/form-data upload
      const formData = new FormData();
      formData.append("file", file);

      // Add optional filename override if provided
      if (filename) {
        formData.append("filename", filename);
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          // Don't set Content-Type header - let the browser set it with boundary
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
      // Invalidate ticket messages query to refresh the message with new attachment
      queryClient.invalidateQueries({
        queryKey: ["ticketMessages", variables.ticket_id],
      });
      // Invalidate specific message query if it exists
      queryClient.invalidateQueries({
        queryKey: ["ticketMessage", variables.ticket_id, variables.message_id],
      });
    },
    ...options,
  });
}
