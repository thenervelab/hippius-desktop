"use client";

import {
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { useInvokeMutation } from "./useInvokeMutation";
import { SSHKeyResponse } from "./useSSHKeys";

// Request payload for creating an SSH key
export interface CreateSSHKeyPayload {
  name: string;
  public_key: string;
}

/**
 * Hook to create an SSH key using react-query mutation
 */
export default function useCreateSSHKey(
  options?: Omit<
    UseMutationOptions<SSHKeyResponse, Error, CreateSSHKeyPayload>,
    "mutationFn"
  >
): UseMutationResult<SSHKeyResponse, Error, CreateSSHKeyPayload> {
  return useInvokeMutation<SSHKeyResponse, CreateSSHKeyPayload>(
    {
      command: "create_ssh_key",
      params: (polkadotAddress, payload) => ({
        accountId: polkadotAddress,
        name: payload.name,
        publicKey: payload.public_key,
      }),
      invalidateKeys: [["sshKeys"]],
    },
    options
  );
}
