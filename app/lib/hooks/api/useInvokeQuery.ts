import {
  useQuery,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { invoke } from "@tauri-apps/api/core";

/** Default query options applied to all invoke-based queries */
const DEFAULT_OPTIONS = {
  staleTime: 30_000,
  refetchOnWindowFocus: false,
  retry: false,
} as const;

/**
 * Where the address fed to the query should come from.
 *
 * - `"auth"` (default): the substrate address from `useWalletAuth`. This is
 *   the master mnemonic the user logged in with — used for billing/credits/
 *   referrals/etc., which are tied to the login identity, not to which
 *   sub-wallet is currently active.
 *
 * - `"activeWallet"`: the address of the currently-selected local wallet
 *   from `useLocalWallet().activeWallet`, falling back to the auth address
 *   while the local-wallet context is still hydrating. This is what every
 *   on-chain view (balance, transfers, balance-over-time) on the wallet
 *   page must use — the user expects the wallet picker in the header to
 *   actually swap the data, and the Rust-side signing helpers already
 *   route through the active local wallet for symmetry.
 */
export type AddressSource = "auth" | "activeWallet";

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
   * Can be a static array or a function receiving the resolved address
   * (useful when the address should be part of the cache key — which it
   * almost always should be, so switching wallets invalidates the cache).
   */
  queryKey: unknown[] | ((address: string | null) => unknown[]);
  /**
   * Build the invoke params object.
   * Receives the resolved address so you can include it (as accountId,
   * address, etc.). Return `null` to skip the invoke (query will be
   * disabled). If omitted, defaults to `{ accountId: address }`.
   */
  params?: (address: string) => Record<string, unknown> | null;
  /** Additional enabled conditions beyond a present address */
  enabled?: boolean;
  /**
   * Which address to feed the query / queryKey / params. Defaults to
   * `"auth"` so existing hooks keep their current behavior. See
   * {@link AddressSource}.
   */
  addressSource?: AddressSource;
  /** Override or extend default query options */
  options?: Omit<
    UseQueryOptions<TResponse, Error, TData>,
    "queryKey" | "queryFn"
  >;
}

/**
 * Factory hook for Tauri invoke-based queries.
 *
 * Handles the address guard, default options, and invoke call. The
 * address can be sourced from auth (default) or the active local wallet
 * via the `addressSource` option — see {@link AddressSource}.
 */
export function useInvokeQuery<TResponse, TData = TResponse>(
  config: InvokeQueryConfig<TResponse, TData>
): UseQueryResult<TData, Error> {
  const { polkadotAddress } = useWalletAuth();
  // `useLocalWallet` throws if called outside LocalWalletProvider; every
  // current useInvokeQuery call site lives under `(pages)/layout.tsx`
  // which mounts the provider, so this is safe. If that ever changes,
  // wrap with a try/catch or split out a hook variant.
  const { activeWallet } = useLocalWallet();

  const source: AddressSource = config.addressSource ?? "auth";
  // Fall back to the auth address while the local-wallet context is
  // still loading; once `activeWallet` resolves, the queryKey changes
  // and the query naturally refetches under the right address.
  const address =
    source === "activeWallet"
      ? activeWallet?.address ?? polkadotAddress
      : polkadotAddress;

  const queryKey =
    typeof config.queryKey === "function"
      ? config.queryKey(address)
      : config.queryKey;

  // A provided `params` builder owns the result, INCLUDING a `null` return,
  // which the contract says disables the query. `?? { accountId }` would have
  // coalesced that null back to the default, silently re-enabling the query —
  // so distinguish "no builder" (use the default) from "builder returned null"
  // (disable).
  const invokeParams = address
    ? config.params
      ? config.params(address)
      : { accountId: address }
    : null;

  const enabled =
    !!address && invokeParams !== null && (config.enabled ?? true);

  return useQuery<TResponse, Error, TData>({
    ...DEFAULT_OPTIONS,
    queryKey,
    queryFn: async () => {
      if (!address) {
        throw new Error("No wallet address available");
      }
      return invoke<TResponse>(config.command, invokeParams!);
    },
    enabled,
    ...config.options,
  });
}
