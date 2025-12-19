"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface VMInstanceDetailsResponse {
  id: number;
  uuid: string | null;
  name: string;
  status: string;
  flavor: {
    name: string;
    cpu_cores: number;
    memory_mb: number;
    disk_gb: number;
  };
  image: string;
  public_ip: string | null;
  nebula_ip: string | null;
  ssh_public_key: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Hook to fetch VM instance details by ID using react-query
 */
export default function useVMInstanceDetails(
  instanceId: number | string,
  options?: Omit<
    UseQueryOptions<
      VMInstanceDetailsResponse,
      Error,
      VMInstanceDetailsResponse
    >,
    "queryKey" | "queryFn"
  >
): UseQueryResult<VMInstanceDetailsResponse, Error> {
  const { oauthSession } = useWalletAuth();

  return useQuery<VMInstanceDetailsResponse, Error, VMInstanceDetailsResponse>({
    queryKey: ["vm-instance-details", instanceId],
    queryFn: async () => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const url = `${API_CONFIG.baseUrl}${API_CONFIG.infrastructure.vm.instance(
        Number(instanceId)
      )}`;

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
          `Failed to fetch VM instance details`;
        throw new Error(message);
      }

      return response.json() as Promise<VMInstanceDetailsResponse>;
    },
    enabled: !!oauthSession?.token && !!instanceId,
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000, // 30 seconds
    ...options,
  });
}
