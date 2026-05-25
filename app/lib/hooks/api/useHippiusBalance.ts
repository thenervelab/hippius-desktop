import { UseQueryOptions } from "@tanstack/react-query";
import { useInvokeQuery } from "./useInvokeQuery";

/**
 * Raw shape from Rust `get_account_balance`. Every `*_hip` field is the
 * pre-formatted HIP display string (`planck_to_hip`). Keep the planck
 * strings for bigint math; use `*_hip` for rendering.
 */
interface AccountBalance {
  free: string;
  freeHip: string;
  reserved: string;
  reservedHip: string;
  frozen: string;
  frozenHip: string;
}

export interface FrameSystemAccountInfo {
  nonce: number;
  consumers: number;
  providers: number;
  sufficients: number;
  data: {
    free: bigint;
    freeHip: string;
    reserved: bigint;
    reservedHip: string;
    frozen: bigint;
    frozenHip: string;
    flags: string;
  };
}

/**
 * Query account balance via Rust `get_account_balance` command.
 * Returns the FrameSystemAccountInfo shape existing UI code expects,
 * augmented with the pre-formatted HIP display strings so consumers
 * don't need to re-implement planck→HIP conversion in JS.
 *
 * No auto-polling by default — the wallet page's My Balance card only
 * refetches on an explicit refresh button click, and `StakeDialog`
 * already calls `refetch()` when it opens and `useStaking` invalidates
 * this query after every stake/unbond. Background polling was forcing
 * the "Last updated" counter to reset every 6 seconds even with the
 * card's own observer opted out, because TanStack Query merges
 * `refetchInterval` across all mounted observers and StakeDialog's
 * (always-mounted, just hidden when closed) observer kept the timer
 * alive. Consumers that genuinely want live polling can re-enable it
 * via the `options` arg.
 */
export function useHippiusBalance(
  options?: Omit<
    UseQueryOptions<AccountBalance, Error, FrameSystemAccountInfo | undefined>,
    "queryKey" | "queryFn"
  >,
) {
  return useInvokeQuery<AccountBalance, FrameSystemAccountInfo | undefined>({
    command: "get_account_balance",
    // Wallet page is per-active-local-wallet; switching wallets in the
    // header swaps the cache key and refetches under the new address.
    addressSource: "activeWallet",
    queryKey: (addr) => ["hippius-balance", addr],
    params: (address) => ({ address }),
    options: {
      staleTime: 0,
      refetchOnWindowFocus: false,
      refetchInterval: false,
      ...options,
      select:
        options?.select ??
        ((balance) => {
          try {
            return {
              nonce: 0,
              consumers: 0,
              providers: 0,
              sufficients: 0,
              data: {
                free: BigInt(balance.free),
                freeHip: balance.freeHip,
                reserved: BigInt(balance.reserved),
                reservedHip: balance.reservedHip,
                frozen: BigInt(balance.frozen),
                frozenHip: balance.frozenHip,
                flags: "0",
              },
            };
          } catch (err) {
            console.error("get_account_balance failed:", err);
            return undefined;
          }
        }),
    },
  });
}
