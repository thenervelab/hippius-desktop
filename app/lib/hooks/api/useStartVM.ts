"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface StartVMResponse {
  message: string;
  status: string;
}

/**
 * Hook to start a VM instance using react-query mutation
 */
export default function useStartVM(
  options?: Omit<
    UseMutationOptions<StartVMResponse, Error, number>,
    "mutationFn"
  >
): UseMutationResult<StartVMResponse, Error, number> {
  const { polkadotAddress } = useWalletAuth();

  return useMutation<StartVMResponse, Error, number>({
    mutationFn: async (instanceId: number) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<StartVMResponse>("start_vm", {
        accountId: polkadotAddress,
        instanceId,
      });
    },
    ...options,
  });
}
