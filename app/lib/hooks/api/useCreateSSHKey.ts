"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  return useMutation<SSHKeyResponse, Error, CreateSSHKeyPayload>({
    mutationFn: async (payload: CreateSSHKeyPayload) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<SSHKeyResponse>("create_ssh_key", {
        accountId: polkadotAddress,
        name: payload.name,
        publicKey: payload.public_key,
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
