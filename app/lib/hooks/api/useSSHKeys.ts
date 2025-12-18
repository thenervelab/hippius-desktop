"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export interface SSHKeyResponse {
  id: number;
  name: string;
  public_key: string;
  fingerprint: string;
  created: string;
  last_used: string;
}

export interface SSHKeysResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: SSHKeyResponse[];
}

export interface UseSSHKeysParams {
  page?: number;
  page_size?: number;
  search?: string;
  ordering?: string;
}

/**
 * Hook to fetch SSH keys using react-query
 */
export default function useSSHKeys(
  params?: UseSSHKeysParams,
  options?: Omit<
    UseQueryOptions<SSHKeysResponse, Error, SSHKeysResponse>,
    "queryKey" | "queryFn"
  >
): UseQueryResult<SSHKeysResponse, Error> {
  const { oauthSession } = useWalletAuth();

  const { page = 1, page_size = 10, search = "", ordering = "" } = params || {};

  return useQuery<SSHKeysResponse, Error, SSHKeysResponse>({
    queryKey: [
      "sshKeys",
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

      // Direct API call
      const url = `${API_CONFIG.baseUrl}${
        API_CONFIG.sshKeys.list
      }?${queryParams.toString()}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Token ${oauthSession.token}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: Failed to fetch SSH keys`);
      }

      return response.json() as Promise<SSHKeysResponse>;
    },
    enabled: !!oauthSession?.token,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
    ...options,
  });
}
