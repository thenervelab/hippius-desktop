import {
  useMutation,
  UseMutationOptions,
  UseMutationResult,
  useQueryClient,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

/**
 * Options for configuring an invoke-based mutation hook.
 *
 * @template TVariables - Variables passed to mutate()
 */
export interface InvokeMutationConfig<TVariables> {
  /** The Tauri command name to invoke */
  command: string;
  /**
   * Build the invoke params from (polkadotAddress, variables).
   * By default sends { accountId: polkadotAddress }.
   */
  params?: (
    polkadotAddress: string,
    variables: TVariables
  ) => Record<string, unknown>;
  /** Query keys to invalidate on success */
  invalidateKeys?: unknown[][];
}

/**
 * Factory hook for Tauri invoke-based mutations.
 *
 * Handles polkadotAddress guard, invoke call, and optional cache invalidation.
 */
export function useInvokeMutation<TResponse, TVariables = void>(
  config: InvokeMutationConfig<TVariables>,
  options?: Omit<
    UseMutationOptions<TResponse, Error, TVariables>,
    "mutationFn"
  >
): UseMutationResult<TResponse, Error, TVariables> {
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  const { onSuccess: userOnSuccess, ...restOptions } = options ?? {};

  return useMutation<TResponse, Error, TVariables>({
    mutationFn: async (variables: TVariables) => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const params = config.params
        ? config.params(polkadotAddress, variables)
        : { accountId: polkadotAddress };

      return invoke<TResponse>(config.command, params);
    },
    onSuccess: (...args) => {
      if (config.invalidateKeys) {
        for (const key of config.invalidateKeys) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      }
      userOnSuccess?.(...args);
    },
    ...restOptions,
  });
}
