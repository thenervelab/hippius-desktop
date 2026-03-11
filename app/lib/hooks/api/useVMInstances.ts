"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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
  const { polkadotAddress } = useWalletAuth();

  return useQuery<VMInstanceResponse[], Error, VMInstanceResponse[]>({
    queryKey: ["vmInstances"],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<VMInstanceResponse[]>("list_vm_instances", {
        accountId: polkadotAddress,
      });
    },
    enabled: !!polkadotAddress,
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000,
    retry: false,
    ...options,
  });
}
