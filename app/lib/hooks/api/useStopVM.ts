"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface StopVMResponse {
  message: string;
  status: string;
}

/**
 * Hook to stop a VM instance using react-query mutation
 */
export default function useStopVM(
  options?: Omit<
    UseMutationOptions<StopVMResponse, Error, number>,
    "mutationFn"
  >
): UseMutationResult<StopVMResponse, Error, number> {
  const { polkadotAddress } = useWalletAuth();

  return useMutation<StopVMResponse, Error, number>({
    mutationFn: async (instanceId: number) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<StopVMResponse>("stop_vm", {
        accountId: polkadotAddress,
        instanceId,
      });
    },
    ...options,
  });
}
