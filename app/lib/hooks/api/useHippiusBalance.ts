import { useInvokeQuery } from "./useInvokeQuery";

interface AccountBalance {
  free: string;
  reserved: string;
  frozen: string;
}

export interface FrameSystemAccountInfo {
  nonce: number;
  consumers: number;
  providers: number;
  sufficients: number;
  data: {
    free: bigint;
    reserved: bigint;
    frozen: bigint;
    flags: string;
  };
}

/**
 * Query account balance via Rust `get_account_balance` command.
 * Returns the same FrameSystemAccountInfo shape for backward compatibility.
 */
export function useHippiusBalance() {
  return useInvokeQuery<AccountBalance, FrameSystemAccountInfo | undefined>({
    command: "get_account_balance",
    queryKey: (addr) => ["hippius-balance", addr],
    params: (polkadotAddress) => ({ address: polkadotAddress }),
    options: {
      refetchInterval: 30_000,
      select: (balance) => {
        try {
          return {
            nonce: 0,
            consumers: 0,
            providers: 0,
            sufficients: 0,
            data: {
              free: BigInt(balance.free),
              reserved: BigInt(balance.reserved),
              frozen: BigInt(balance.frozen),
              flags: "0",
            },
          };
        } catch (err) {
          console.error("get_account_balance failed:", err);
          return undefined;
        }
      },
    },
  });
}
