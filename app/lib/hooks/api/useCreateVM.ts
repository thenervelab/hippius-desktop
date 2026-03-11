"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface CreateVMRequest {
  flavor_id: number;
  image_id: number;
  ssh_public_key: string;
  name: string;
  application_id?: number;
}

export interface CreateVMResponse {
  id: number;
  name: string;
  flavor_id: number;
  image_id: number;
  status: string;
  created: string;
}

/**
 * Hook to create/spawn a new VM instance using react-query mutation
 */
export default function useCreateVM(
  options?: Omit<
    UseMutationOptions<CreateVMResponse, Error, CreateVMRequest>,
    "mutationFn"
  >
): UseMutationResult<CreateVMResponse, Error, CreateVMRequest> {
  const { polkadotAddress } = useWalletAuth();

  return useMutation<CreateVMResponse, Error, CreateVMRequest>({
    mutationFn: async (data: CreateVMRequest) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<CreateVMResponse>("create_vm", {
        accountId: polkadotAddress,
        params: data,
      });
    },
    ...options,
  });
}
