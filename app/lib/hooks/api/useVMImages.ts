"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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
  const { polkadotAddress } = useWalletAuth();

  return useQuery<VMImageResponse[], Error, VMImageResponse[]>({
    queryKey: ["vmImages"],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<VMImageResponse[]>("list_vm_images", {
        accountId: polkadotAddress,
      });
    },
    enabled: !!polkadotAddress,
    refetchOnWindowFocus: false,
    staleTime: 10 * 60 * 1000,
    ...options,
  });
}
