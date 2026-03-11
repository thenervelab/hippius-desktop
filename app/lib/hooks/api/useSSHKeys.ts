"use client";

import {
  UseQueryOptions,
  UseQueryResult,
  keepPreviousData,
} from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

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
  const { page = 1, page_size = 10, search = "", ordering = "" } = params || {};

  return useInvokeQuery<SSHKeysResponse>({
    command: "list_ssh_keys",
    queryKey: ["sshKeys", page, page_size, search, ordering],
    params: (polkadotAddress) => ({
      accountId: polkadotAddress,
      page,
      pageSize: page_size,
      search: search || null,
      ordering: ordering || null,
    }),
    options: {
      placeholderData: keepPreviousData,
      staleTime: 5 * 60 * 1000,
      ...options,
    },
  });
}
