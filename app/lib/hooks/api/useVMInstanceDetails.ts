"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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
  const { polkadotAddress } = useWalletAuth();

  return useQuery<VMInstanceDetailsResponse, Error, VMInstanceDetailsResponse>({
    queryKey: ["vm-instance-details", instanceId],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<VMInstanceDetailsResponse>("get_vm_instance", {
        accountId: polkadotAddress,
        instanceId: Number(instanceId),
      });
    },
    enabled: !!polkadotAddress && !!instanceId,
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000,
    ...options,
  });
}
