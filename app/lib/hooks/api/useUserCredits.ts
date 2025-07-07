/* eslint-disable @typescript-eslint/no-explicit-any */
import { usePolkadotApi } from "@/lib/polkadot-api-context";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useQuery } from "@tanstack/react-query";

export function useUserCredits() {
  const { api, isConnected } = usePolkadotApi();
  const { polkadotAddress } = useWalletAuth();

  return useQuery({
    queryKey: ["user-credits", polkadotAddress],
    refetchInterval: 30000,
    queryFn: async () => {
      if (!api || !isConnected || !polkadotAddress) {
        throw new Error("Failed to fetch");
      }

      try {
        // Use direct chain state query
        const creditsResult =
          await api.query.credits.freeCredits(polkadotAddress);

        // Extract the value (assuming it could be an Option type)
        let creditAmount = BigInt(0);
        if (creditsResult as any) {
          if ("isSome" in creditsResult && creditsResult.isSome) {
            creditAmount = BigInt((creditsResult as any).unwrap().toString());
          } else {
            creditAmount = BigInt(creditsResult.toString());
          }
        }

        // Return the raw BigInt value for calculations
        return creditAmount;
      } catch (error) {
        console.error("Error fetching credits:", error);
        return BigInt(0);
      }
    },
  });
}
