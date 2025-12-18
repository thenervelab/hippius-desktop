"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface VMImageResponse {
  id: number;
  name: string;
  slug: string;
  description: string;
}

/**
 * Hook to fetch VM OS images using react-query
 */
export default function useVMImages(
  options?: Omit<
    UseQueryOptions<VMImageResponse[], Error, VMImageResponse[]>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<VMImageResponse[], Error> {
  const { oauthSession } = useWalletAuth();

  return useQuery<VMImageResponse[], Error, VMImageResponse[]>({
    queryKey: ["vmImages", oauthSession?.token],
    queryFn: async () => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const url = `${API_CONFIG.baseUrl}${API_CONFIG.infrastructure.vm.images}`;

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
          `Failed to fetch VM images`;
        throw new Error(message);
      }

      return response.json() as Promise<VMImageResponse[]>;
    },
    enabled: !!oauthSession?.token,
    refetchOnWindowFocus: false,
    staleTime: 10 * 60 * 1000, // 10 minutes (images don't change often)
    ...options,
  });
}
