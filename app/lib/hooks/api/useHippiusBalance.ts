import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useQuery } from "@tanstack/react-query";

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
 * Read `system.account(AccountId32) -> FrameSystemAccountInfo`
 * Returns account info with balance data (free, reserved, frozen)
 * Returns undefined → api not ready or any error
 */
export function useHippiusBalance() {
  const { api, isConnected } = usePolkadotApi();
  const { polkadotAddress } = useWalletAuth();

  return useQuery<FrameSystemAccountInfo | undefined>({
    queryKey: ["hippius-balance", polkadotAddress],
    enabled: !!polkadotAddress, // don't run before we have an address
    refetchInterval: 30_000,

    queryFn: async () => {
      /* ── Guard: API not ready ───────────────────────────── */
      if (!api || !isConnected || !polkadotAddress) return undefined;

      try {
        const accountInfo = await api.query.system.account(polkadotAddress);

        // Convert the account info to a plain object with BigInt values
        const rawData = accountInfo.toJSON() as any;

        return {
          nonce: rawData.nonce,
          consumers: rawData.consumers,
          providers: rawData.providers,
          sufficients: rawData.sufficients,
          data: {
            free: BigInt(rawData.data.free || 0),
            reserved: BigInt(rawData.data.reserved || 0),
            frozen: BigInt(rawData.data.frozen || 0),
            flags: rawData.data.flags,
          },
        };
      } catch (err) {
        console.error("system.account query failed:", err);
        /* any error → treat as no data */
        return undefined;
      }
    },
  });
}
