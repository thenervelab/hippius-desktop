"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface VMInstanceResponse {
  id: number;
  name: string;
  flavor_id: number;
  image_id: number;
  status: string;
  created: string;
  ip_address?: string;
  [key: string]: any;
}

export interface VMInstancesResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: VMInstanceResponse[];
}

export interface UseVMInstancesParams {
  page?: number;
  page_size?: number;
  search?: string;
  ordering?: string;
}

/**
 * Hook to fetch VM instances using react-query
 */
export default function useVMInstances(
  params?: UseVMInstancesParams,
  options?: Omit<
    UseQueryOptions<VMInstancesResponse, Error, VMInstancesResponse>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<VMInstancesResponse, Error> {
  const { oauthSession } = useWalletAuth();

  const { page = 1, page_size = 10, search = "", ordering = "" } = params || {};

  return useQuery<VMInstancesResponse, Error, VMInstancesResponse>({
    queryKey: [
      "vmInstances",
      page,
      page_size,
      search,
      ordering,
      oauthSession?.token,
    ],
    queryFn: async () => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      // Build query string
      const queryParams = new URLSearchParams({
        page: String(page),
        page_size: String(page_size),
      });

      // Add search parameter if provided
      if (search) {
        queryParams.append("search", search);
      }

      // Add ordering parameter if provided
      if (ordering) {
        queryParams.append("ordering", ordering);
      }

      const url = `${API_CONFIG.baseUrl}${
        API_CONFIG.infrastructure.vm.instances
      }?${queryParams.toString()}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: Failed to fetch VM instances`
        );
      }

      return response.json() as Promise<VMInstancesResponse>;
    },
    enabled: !!oauthSession?.token,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000, // 30 seconds (instances change frequently)
    ...options,
  });
}
