"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { SSHKeyResponse } from "./useSSHKeys";

// Request payload for creating an SSH key
export interface CreateSSHKeyPayload {
  name: string;
  public_key: string;
}

/**
 * Hook to create an SSH key using react-query mutation
 */
export default function useCreateSSHKey(
  options?: Omit<
    UseMutationOptions<SSHKeyResponse, Error, CreateSSHKeyPayload>,
    "mutationFn"
  >
): UseMutationResult<SSHKeyResponse, Error, CreateSSHKeyPayload> {
  const { oauthSession } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<SSHKeyResponse, Error, CreateSSHKeyPayload>({
    mutationFn: async (payload: CreateSSHKeyPayload) => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const url = `${API_CONFIG.baseUrl}${API_CONFIG.sshKeys.create}`;

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
            errorData.detail ||
            `HTTP ${response.status}: Failed to create SSH key`
        );
      }

      return response.json() as Promise<SSHKeyResponse>;
    },
    onSuccess: () => {
      // Invalidate SSH keys query to refetch the list
      queryClient.invalidateQueries({
        queryKey: ["sshKeys"],
      });
    },
    ...options,
  });
}
