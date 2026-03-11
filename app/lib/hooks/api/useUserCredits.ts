import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

/**
 * Fetch user credits from API
 * Returns bigint   → balance value (scaled to 18 decimals)
 * Returns undefined → no token or error
 */
export function useUserCredits() {
  const { polkadotAddress } = useWalletAuth();

  return useQuery<bigint | undefined>({
    queryKey: ["user-credits", polkadotAddress],
    refetchOnWindowFocus: false,
    enabled: !!polkadotAddress,
    staleTime: Infinity,
    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No wallet address available");
      }

      const data = await invoke<{ balance?: string }>("get_user_credits_balance", {
        accountId: polkadotAddress,
      });

      // Convert balance string to bigint (scaled to 18 decimals)
      const balanceStr = data.balance || "0";
      const balance = parseFloat(balanceStr) * Math.pow(10, 18);
      return BigInt(Math.floor(balance));
    },
  });
}
