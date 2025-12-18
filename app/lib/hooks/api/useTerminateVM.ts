"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
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
  const { oauthSession } = useWalletAuth();

  return useMutation<TerminateVMResponse, Error, number>({
    mutationFn: async (instanceId: number) => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const url = `${
        API_CONFIG.baseUrl
      }${API_CONFIG.infrastructure.vm.terminate(instanceId)}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const message =
          errorData.message ||
          errorData.error ||
          errorData.detail ||
          `Failed to terminate VM instance`;
        throw new Error(message);
      }

      return response.json() as Promise<TerminateVMResponse>;
    },
    ...options,
  });
}
