"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface VMInstanceResponse {
  id: number;
  uuid: string | null;
  name: string;
  status: string;
  flavor: string;
  image: string;
  public_ip: string | null;
  nebula_ip: string | null;
  created_at: string;
}

/**
 * Hook to fetch VM instances using react-query
 */
export default function useVMInstances(
  options?: Omit<
    UseQueryOptions<VMInstanceResponse[], Error, VMInstanceResponse[]>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<VMInstanceResponse[], Error> {
  const { oauthSession } = useWalletAuth();

  return useQuery<VMInstanceResponse[], Error, VMInstanceResponse[]>({
    queryKey: ["vmInstances", oauthSession?.token],
    queryFn: async () => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const url = `${API_CONFIG.baseUrl}${API_CONFIG.infrastructure.vm.instances}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: Failed to fetch VM instances`
        );
      }

      return response.json() as Promise<VMInstanceResponse[]>;
    },
    enabled: !!oauthSession?.token,
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000, // 30 seconds (instances change frequently)
    ...options,
  });
}
