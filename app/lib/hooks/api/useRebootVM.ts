"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface RebootVMResponse {
  message: string;
  status: string;
}

/**
 * Hook to reboot a VM instance using react-query mutation
 */
export default function useRebootVM(
  options?: Omit<
    UseMutationOptions<RebootVMResponse, Error, number>,
    "mutationFn"
  >
): UseMutationResult<RebootVMResponse, Error, number> {
  const { polkadotAddress } = useWalletAuth();

  return useMutation<RebootVMResponse, Error, number>({
    mutationFn: async (instanceId: number) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<RebootVMResponse>("reboot_vm", {
        accountId: polkadotAddress,
        instanceId,
      });
    },
    ...options,
  });
}
