"use client";

import { UseMutationOptions, UseMutationResult } from "@tanstack/react-query";
import { useVMAction, VMActionResponse } from "./useVMAction";

export interface StopVMResponse {
  message: string;
  status: string;
}

/**
 * Hook to stop a VM instance using react-query mutation
 */
export default function useStopVM(
  options?: Omit<
    UseMutationOptions<VMActionResponse, Error, number>,
    "mutationFn"
  >
): UseMutationResult<VMActionResponse, Error, number> {
  return useVMAction("stop_vm", options);
}
