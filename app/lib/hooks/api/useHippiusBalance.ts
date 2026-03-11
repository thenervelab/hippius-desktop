import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

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
  const { polkadotAddress } = useWalletAuth();

  return useQuery<FrameSystemAccountInfo | undefined>({
    queryKey: ["hippius-balance", polkadotAddress],
    enabled: !!polkadotAddress,
    refetchInterval: 30_000,

    queryFn: async () => {
      if (!polkadotAddress) return undefined;

      try {
        const balance = await invoke<AccountBalance>("get_account_balance", {
          address: polkadotAddress,
        });

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
  });
}
