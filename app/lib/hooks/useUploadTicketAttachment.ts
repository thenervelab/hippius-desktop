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
  uploadedAt: string;
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
  >
): UseMutationResult<TicketAttachment, Error, UploadTicketAttachmentPayload> {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<TicketAttachment, Error, UploadTicketAttachmentPayload>({
    mutationFn: async (payload: UploadTicketAttachmentPayload) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const { ticket_id, message_id, file, filename } = payload;

      // Write browser File to temp disk (Rust can't receive File objects over IPC)
      const { tempDir } = await import("@tauri-apps/api/path");
      const baseTmpDir = await tempDir();
      const tmpPath = `${baseTmpDir}hippius_attachment_${Date.now()}_${file.name}`;
      const { writeFile: tauriWriteFile } = await import("@tauri-apps/plugin-fs");
      const arrayBuffer = await file.arrayBuffer();
      await tauriWriteFile(tmpPath, new Uint8Array(arrayBuffer));

      // Rust handles auth + multipart upload — no hardcoded URL needed
      return invoke<TicketAttachment>("upload_ticket_attachment", {
        accountId: polkadotAddress,
        ticketId: ticket_id,
        messageId: message_id,
        filePath: tmpPath,
        filename: filename ?? file.name,
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
