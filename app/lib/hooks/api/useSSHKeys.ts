"use client";

import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
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
  const { polkadotAddress } = useWalletAuth();

  const { page = 1, page_size = 10, search = "", ordering = "" } = params || {};

  return useQuery<SSHKeysResponse, Error, SSHKeysResponse>({
    queryKey: [
      "sshKeys",
      page,
      page_size,
      search,
      ordering,
    ],
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      return invoke<SSHKeysResponse>("list_ssh_keys", {
        accountId: polkadotAddress,
        page,
        pageSize: page_size,
        search: search || null,
        ordering: ordering || null,
      });
    },
    enabled: !!polkadotAddress,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
    ...options,
  });
}
