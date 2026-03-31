"use client";

import {
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { useInvokeMutation } from "./useInvokeMutation";

/**
 * Hook to delete an SSH key using react-query mutation
 */
export default function useDeleteSSHKey(
  options?: Omit<UseMutationOptions<void, Error, number>, "mutationFn">
): UseMutationResult<void, Error, number> {
  return useInvokeMutation<void, number>(
    {
      command: "delete_ssh_key",
      params: (polkadotAddress, id) => ({
        accountId: polkadotAddress,
        keyId: id,
      }),
      invalidateKeys: [["sshKeys"]],
    },
    options
  );
}
