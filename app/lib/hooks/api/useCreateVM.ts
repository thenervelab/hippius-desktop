"use client";

import {
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { useInvokeMutation } from "./useInvokeMutation";

export interface CreateVMRequest {
  flavor_id: number;
  image_id: number;
  ssh_public_key: string;
  name: string;
  application_id?: number;
}

export interface CreateVMResponse {
  id: number;
  name: string;
  flavor_id: number;
  image_id: number;
  status: string;
  created: string;
}

/**
 * Hook to create/spawn a new VM instance using react-query mutation
 */
export default function useCreateVM(
  options?: Omit<
    UseMutationOptions<CreateVMResponse, Error, CreateVMRequest>,
    "mutationFn"
  >
): UseMutationResult<CreateVMResponse, Error, CreateVMRequest> {
  return useInvokeMutation<CreateVMResponse, CreateVMRequest>(
    {
      command: "create_vm",
      params: (polkadotAddress, data) => ({
        accountId: polkadotAddress,
        params: data,
      }),
    },
    options
  );
}
