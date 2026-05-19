"use client";

import {
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

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
  return useInvokeQuery<VMInstanceDetailsResponse>({
    command: "get_vm_instance",
    queryKey: ["vm-instance-details", instanceId],
    params: (polkadotAddress) => ({
      accountId: polkadotAddress,
      instanceId: Number(instanceId),
    }),
    enabled: !!instanceId,
    options: {
      staleTime: 30 * 1000,
      ...options,
    },
  });
}
