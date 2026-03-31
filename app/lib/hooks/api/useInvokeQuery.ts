import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";

/** Default query options applied to all invoke-based queries */
const DEFAULT_OPTIONS = {
  staleTime: 30_000,
  refetchOnWindowFocus: false,
  retry: false,
} as const;

/**
 * Options for configuring an invoke-based query hook.
 *
 * @template TResponse - Raw response type from invoke
 * @template TData - Transformed data type (after select)
 */
export interface InvokeQueryConfig<TResponse, TData = TResponse> {
  /** The Tauri command name to invoke */
  command: string;
  /**
   * TanStack Query key.
   * Can be a static array or a function receiving polkadotAddress
   * (useful when the address should be part of the cache key).
   */
  queryKey: unknown[] | ((polkadotAddress: string | null) => unknown[]);
  /**
   * Build the invoke params object.
   * Receives polkadotAddress so you can include it (as accountId, address, etc.).
   * Return `null` to skip the invoke (query will be disabled).
   * If omitted, defaults to `{ accountId: polkadotAddress }`.
   */
  params?: (polkadotAddress: string) => Record<string, unknown> | null;
  /** Additional enabled conditions beyond !!polkadotAddress */
  enabled?: boolean;
  /** Override or extend default query options */
  options?: Omit<
    UseQueryOptions<TResponse, Error, TData>,
    "queryKey" | "queryFn"
  >;
}

/**
 * Factory hook for Tauri invoke-based queries.
 *
 * Handles the polkadotAddress guard, default options, and invoke call.
 * For hooks where TData === TResponse, omit the second type param.
 */
export function useInvokeQuery<TResponse, TData = TResponse>(
  config: InvokeQueryConfig<TResponse, TData>
): UseQueryResult<TData, Error> {
  const { polkadotAddress } = useWalletAuth();

  const queryKey =
    typeof config.queryKey === "function"
      ? config.queryKey(polkadotAddress)
      : config.queryKey;

  const invokeParams = polkadotAddress
    ? config.params?.(polkadotAddress) ?? { accountId: polkadotAddress }
    : null;

  const enabled =
    !!polkadotAddress &&
    invokeParams !== null &&
    (config.enabled ?? true);

  return useQuery<TResponse, Error, TData>({
    ...DEFAULT_OPTIONS,
    queryKey,
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }
      return invoke<TResponse>(config.command, invokeParams!);
    },
    enabled,
    ...config.options,
  });
}
