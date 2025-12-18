"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";

/**
 * Hook to delete an SSH key using react-query mutation
 */
export default function useDeleteSSHKey(
  options?: Omit<UseMutationOptions<void, Error, number>, "mutationFn">
): UseMutationResult<void, Error, number> {
  const { oauthSession } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<void, Error, number>({
    mutationFn: async (id: number) => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const url = `${API_CONFIG.baseUrl}${API_CONFIG.sshKeys.delete(
        id.toString()
      )}`;

      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.message ||
            errorData.detail ||
            `HTTP ${response.status}: Failed to delete SSH key`
        );
      }

      // DELETE typically returns 204 No Content, so no need to parse response
      return;
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
