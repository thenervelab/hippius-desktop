"use client";

import {
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

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
  return useInvokeQuery<VMImageResponse[]>({
    command: "list_vm_images",
    queryKey: ["vmImages"],
    options: {
      staleTime: 10 * 60 * 1000,
      ...options,
    },
  });
}
