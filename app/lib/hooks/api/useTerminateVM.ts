"use client";

import { UseMutationOptions, UseMutationResult } from "@tanstack/react-query";
import { useVMAction, VMActionResponse } from "./useVMAction";

export interface TerminateVMResponse {
  message: string;
  status: string;
}

/**
 * Hook to terminate (delete) a VM instance using react-query mutation
 */
export default function useTerminateVM(
  options?: Omit<
    UseMutationOptions<VMActionResponse, Error, number>,
    "mutationFn"
  >
): UseMutationResult<VMActionResponse, Error, number> {
  return useVMAction("terminate_vm", options);
}
