"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
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
  const { oauthSession } = useWalletAuth();

  return useMutation<StartVMResponse, Error, number>({
    mutationFn: async (instanceId: number) => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const url = `${API_CONFIG.baseUrl}${API_CONFIG.infrastructure.vm.start(
        instanceId
      )}`;

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
          errorData.error ||
          errorData.message ||
          errorData.detail ||
          `Failed to start VM instance`;
        throw new Error(message);
      }

      return response.json() as Promise<StartVMResponse>;
    },
    ...options,
  });
}
