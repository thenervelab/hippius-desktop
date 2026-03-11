"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

/**
 * Hook to delete an SSH key using react-query mutation
 */
export default function useDeleteSSHKey(
  options?: Omit<UseMutationOptions<void, Error, number>, "mutationFn">
): UseMutationResult<void, Error, number> {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<void, Error, number>({
    mutationFn: async (id: number) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      await invoke("delete_ssh_key", {
        accountId: polkadotAddress,
        keyId: id,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["sshKeys"],
      });
    },
    ...options,
  });
}
