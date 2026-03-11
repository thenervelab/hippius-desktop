"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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
  const { polkadotAddress } = useWalletAuth();

  return useQuery<VMFlavorResponse[], Error, VMFlavorResponse[]>({
    queryKey: ["vmFlavors"],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<VMFlavorResponse[]>("list_vm_flavors", {
        accountId: polkadotAddress,
      });
    },
    enabled: !!polkadotAddress,
    refetchOnWindowFocus: false,
    staleTime: 10 * 60 * 1000,
    retry: false,
    ...options,
  });
}
