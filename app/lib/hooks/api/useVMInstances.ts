"use client";

import {
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

export interface VMInstanceResponse {
  id: number;
  uuid: string | null;
  name: string;
  status: string;
  flavor: string;
  image: string;
  public_ip: string | null;
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
  return useInvokeQuery<VMInstanceResponse[]>({
    command: "list_vm_instances",
    queryKey: ["vmInstances"],
    options: {
      staleTime: 30 * 1000,
      ...options,
    },
  });
}
