import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useQuery } from "@tanstack/react-query";
import { API_CONFIG } from "@/lib/config";

/**
 * Fetch user credits from API
 * Returns bigint   → balance value (scaled to 18 decimals)
 * Returns undefined → no token or error
 */
export function useUserCredits() {
  const { oauthSession } = useWalletAuth();

  return useQuery<bigint | undefined>({
    queryKey: ["user-credits", oauthSession?.userId],
    refetchOnWindowFocus: false,
    enabled: !!oauthSession?.token,
    staleTime: Infinity, // Keep data fresh indefinitely - only refetch when manually invalidated
    queryFn: async () => {
      if (!oauthSession?.token) {
        throw new Error("No authentication token available");
      }

      const response = await fetch(
        `${API_CONFIG.baseUrl}${API_CONFIG.billing.credits}`,
        {
          method: "GET",
          headers: {
            Authorization: `Token ${oauthSession.token}`,
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch credits balance: ${response.status}`);
      }

      const data = await response.json();

      // Convert balance string to bigint (scaled to 18 decimals)
      const balanceStr = data.balance || "0";
      const balance = parseFloat(balanceStr) * Math.pow(10, 18);
      return BigInt(Math.floor(balance));
    },
  });
}