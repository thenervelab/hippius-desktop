/* eslint-disable @typescript-eslint/no-explicit-any */
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useQuery } from "@tanstack/react-query";

/**
 * Read `credits.freeCredits(AccountId32) -> u128`
 * Returns bigint   → on-chain value
 * Returns undefined → api not ready, Option::None, or any error
 */
export function useUserCredits() {
  const { api, isConnected } = usePolkadotApi();
  const { polkadotAddress } = useWalletAuth();

  return useQuery<bigint | undefined>({
    queryKey: ["user-credits", polkadotAddress],
    enabled: !!polkadotAddress, // don’t run before we have an address
    refetchInterval: 30_000,

    queryFn: async () => {
      /* ── Guard: API not ready ───────────────────────────── */
      if (!api || !isConnected || !polkadotAddress) return undefined;

      try {
        const raw = await api.query.credits.freeCredits(polkadotAddress);

        /* Option<Balance> case (toggle in explorer shows “include option”) */
        if ("isSome" in raw) {
          if (!raw.isSome) return undefined; // Option::None → undefined
          return BigInt((raw as any).unwrap().toString());
        }

        /* Plain u128 balance */
        return BigInt(raw.toString());
      } catch (err) {
        console.error("freeCredits query failed:", err);
        /* any error → treat as no data */
        return undefined;
      }
    },
  });
}
