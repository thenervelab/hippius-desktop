"use client";

import {
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

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
  return useInvokeQuery<VMApplicationResponse[]>({
    command: "list_vm_applications",
    queryKey: ["vmApplications"],
    options: {
      staleTime: 60 * 60 * 1000,
      ...options,
    },
  });
}
