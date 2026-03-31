"use client";

import { UseMutationOptions, UseMutationResult } from "@tanstack/react-query";
import { useVMAction, VMActionResponse } from "./useVMAction";

export interface StartVMResponse {
  message: string;
  status: string;
}

/**
 * Hook to start a VM instance using react-query mutation
 */
export default function useStartVM(
  options?: Omit<
    UseMutationOptions<VMActionResponse, Error, number>,
    "mutationFn"
  >
): UseMutationResult<VMActionResponse, Error, number> {
  return useVMAction("start_vm", options);
}
