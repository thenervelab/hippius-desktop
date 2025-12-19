"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface VMFlavorResponse {
  id: number;
  name: string;
  display_name: string;
  cpu_cores: number;
  memory_mb: number;
  data_disk_gb: number;
  credits_per_hour: number;
}

/**
 * Hook to fetch VM flavors using react-query
 */
export default function useVMFlavors(
  options?: Omit<
    UseQueryOptions<VMFlavorResponse[], Error, VMFlavorResponse[]>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<VMFlavorResponse[], Error> {
  const { oauthSession } = useWalletAuth();

  return useQuery<VMFlavorResponse[], Error, VMFlavorResponse[]>({
    queryKey: ["vmFlavors"],
    queryFn: async () => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const url = `${API_CONFIG.baseUrl}${API_CONFIG.infrastructure.vm.flavors}`;

      const response = await fetch(url, {
        method: "GET",
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
          `Failed to fetch VM flavors`;
        throw new Error(message);
      }

      return response.json() as Promise<VMFlavorResponse[]>;
    },
    enabled: !!oauthSession?.token,
    refetchOnWindowFocus: false,
    staleTime: 10 * 60 * 1000, // 10 minutes (flavors don't change often)
    retry: false, // Don't retry on error to avoid long loading states
    ...options,
  });
}
