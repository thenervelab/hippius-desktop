"use client";

import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface CreateVMRequest {
  flavor_id: number;
  image_id: number;
  ssh_public_key: string;
  name: string;
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
  const { oauthSession } = useWalletAuth();

  return useMutation<CreateVMResponse, Error, CreateVMRequest>({
    mutationFn: async (data: CreateVMRequest) => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const url = `${API_CONFIG.baseUrl}${API_CONFIG.infrastructure.vm.spawn}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

        // Handle specific error codes
        if (response.status === 402) {
          throw new Error(
            "Insufficient credits. VM creation requires 10+ credits."
          );
        } else if (response.status === 403) {
          throw new Error("Beta access required to create VMs.");
        } else if (response.status === 409) {
          throw new Error(
            "You already have a pending VM. Please wait for it to complete."
          );
        } else if (response.status === 400) {
          const message =
            errorData.error ||
            errorData.message ||
            errorData.detail ||
            "Invalid request";
          throw new Error(message);
        }
        const message =
          errorData.error ||
          errorData.message ||
          errorData.detail ||
          "Invalid request";
        throw new Error(
          `HTTP ${response.status}: Failed to create VM instance - ${message}`
        );
      }

      return response.json() as Promise<CreateVMResponse>;
    },
    ...options,
  });
}
