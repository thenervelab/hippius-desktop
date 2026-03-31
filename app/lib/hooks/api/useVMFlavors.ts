"use client";

import {
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

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
  return useInvokeQuery<VMFlavorResponse[]>({
    command: "list_vm_flavors",
    queryKey: ["vmFlavors"],
    options: {
      staleTime: 10 * 60 * 1000,
      ...options,
    },
  });
}
