"use client";

import {
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { useInvokeMutation } from "./useInvokeMutation";

export interface VMActionResponse {
  message: string;
  status: string;
}

/**
 * Factory for VM instance action hooks (start, stop, reboot, terminate).
 * All share the same shape: mutate(instanceId: number) => { message, status }.
 */
export function useVMAction(
  command: string,
  options?: Omit<
    UseMutationOptions<VMActionResponse, Error, number>,
    "mutationFn"
  >
): UseMutationResult<VMActionResponse, Error, number> {
  return useInvokeMutation<VMActionResponse, number>(
    {
      command,
      params: (polkadotAddress, instanceId) => ({
        accountId: polkadotAddress,
        instanceId,
      }),
    },
    options
  );
}
