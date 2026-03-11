"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface TerminateVMResponse {
  message: string;
  status: string;
}

/**
 * Hook to terminate (delete) a VM instance using react-query mutation
 */
export default function useTerminateVM(
  options?: Omit<
    UseMutationOptions<TerminateVMResponse, Error, number>,
    "mutationFn"
  >
): UseMutationResult<TerminateVMResponse, Error, number> {
  const { polkadotAddress } = useWalletAuth();

  return useMutation<TerminateVMResponse, Error, number>({
    mutationFn: async (instanceId: number) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<TerminateVMResponse>("terminate_vm", {
        accountId: polkadotAddress,
        instanceId,
      });
    },
    ...options,
  });
}
