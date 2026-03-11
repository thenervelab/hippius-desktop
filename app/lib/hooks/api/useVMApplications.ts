"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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
  const { polkadotAddress } = useWalletAuth();

  return useQuery<VMApplicationResponse[], Error, VMApplicationResponse[]>({
    queryKey: ["vmApplications"],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<VMApplicationResponse[]>("list_vm_applications", {
        accountId: polkadotAddress,
      });
    },
    enabled: !!polkadotAddress,
    refetchOnWindowFocus: false,
    staleTime: 60 * 60 * 1000,
    retry: false,
    ...options,
  });
}
