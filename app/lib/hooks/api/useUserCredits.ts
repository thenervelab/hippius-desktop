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

      // Make a direct JSON-RPC call to the node
      const response = await fetch("https://rpc.hippius.network", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "get_free_credits",
          params: [polkadotAddress],
          id: 1,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log("Credits RPC response:", data);

      if (data.error) {
        throw new Error(data.error.message || "Failed to fetch credits");
      }

      if (data.result && Array.isArray(data.result)) {
        // The result is a list of tuples [AccountId, u128]
        // Find the tuple for our address
        const userCreditsTuple = data.result.find((tuple: any) => {
          // The first element is the account ID
          const accountId = tuple[0];
          return (
            accountId === polkadotAddress ||
            accountId.toString() === polkadotAddress
          );
        });

        if (userCreditsTuple) {
          // The second element is the credits amount
          const creditAmount = userCreditsTuple[1];

          return BigInt(creditAmount);
        } else {
          return BigInt(0);
        }
      } else {
        return BigInt(0);
      }
    },
  });
}
