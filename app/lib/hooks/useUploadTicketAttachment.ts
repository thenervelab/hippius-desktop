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
  filePath: string;
  filename: string;
}

// Response type for a ticket attachment
export interface TicketAttachment {
  id: number;
  filename: string;
  file: string;
  uploaded_at: string;
}

/**
 * Hook to upload an attachment to a ticket message.
 *
 * Writes the browser File to a temp path, then delegates to Rust for the
 * multipart upload — no hardcoded URL or auth token in the frontend.
 */
export default function useUploadTicketAttachment(
  options?: Omit<
    UseMutationOptions<TicketAttachment, Error, UploadTicketAttachmentPayload>,
    "mutationFn"
  >,
): UseMutationResult<TicketAttachment, Error, UploadTicketAttachmentPayload> {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<TicketAttachment, Error, UploadTicketAttachmentPayload>({
    mutationFn: async (payload: UploadTicketAttachmentPayload) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const { ticket_id, message_id, filePath, filename } = payload;

      // Rust reads the file directly from disk and handles auth + multipart upload
      return invoke<TicketAttachment>("upload_ticket_attachment", {
        accountId: polkadotAddress,
        ticketId: ticket_id,
        messageId: message_id,
        filePath,
        filename,
      });
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
