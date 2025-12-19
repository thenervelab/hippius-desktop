"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface VMApplicationResponse {
  id: number;
  name: string;
  slug: string;
  description: string;
  logo_url: string;
}

/**
 * Hook to fetch VM One-Click Applications (Docker, Postgres, etc.) using react-query
 */
export default function useVMApplications(
  options?: Omit<
    UseQueryOptions<VMApplicationResponse[], Error, VMApplicationResponse[]>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<VMApplicationResponse[], Error> {
  const { oauthSession } = useWalletAuth();

  return useQuery<VMApplicationResponse[], Error, VMApplicationResponse[]>({
    queryKey: ["vmApplications"],
    queryFn: async () => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const url = `${API_CONFIG.baseUrl}${API_CONFIG.infrastructure.vm.applications}`;

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
          `Failed to fetch VM applications`;
        throw new Error(message);
      }

      return response.json() as Promise<VMApplicationResponse[]>;
    },
    enabled: !!oauthSession?.token,
    refetchOnWindowFocus: false,
    staleTime: 60 * 60 * 1000, // 1 hour (applications don't change often)
    retry: false, // Don't retry on error to avoid long loading states
    ...options,
  });
}
