import { useWalletAuth } from "@/lib/wallet-auth-context";
import { useQuery } from "@tanstack/react-query";
import { ensureBillingAuth } from "./useBillingAuth";
import { getApiAuth } from "@/app/lib/helpers/sessionStore";

/**
 * Fetch user credits from API
 * Returns bigint   → balance value (scaled to 18 decimals)
 * Returns undefined → no token or error
 */
export function useUserCredits() {
  const { polkadotAddress } = useWalletAuth();

  return useQuery<bigint | undefined>({
    queryKey: ["user-credits", polkadotAddress],
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    enabled: !!polkadotAddress,

    queryFn: async () => {
      if (!polkadotAddress) {
        throw new Error("No Polkadot address available");
      }

      // Ensure we have a valid billing auth token
      const authResult = await ensureBillingAuth();
      if (!authResult.ok) {
        throw new Error(authResult.error || "Failed to authenticate for billing");
      }

      // Get the token from storage
      const apiAuth = await getApiAuth();
      if (!apiAuth?.token) {
        throw new Error("No API token available after authentication");
      }

      const response = await fetch(
        `https://api.hippius.com/api/billing/credits/balance/`,
        {
          method: "GET",
          headers: {
            Authorization: `Token ${apiAuth.token}`,
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
