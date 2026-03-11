"use client";

import { UseMutationOptions, UseMutationResult } from "@tanstack/react-query";
import { useVMAction, VMActionResponse } from "./useVMAction";

export interface RebootVMResponse {
  message: string;
  status: string;
}

/**
 * Hook to reboot a VM instance using react-query mutation
 */
export default function useRebootVM(
  options?: Omit<
    UseMutationOptions<VMActionResponse, Error, number>,
    "mutationFn"
  >
): UseMutationResult<VMActionResponse, Error, number> {
  return useVMAction("reboot_vm", options);
}
