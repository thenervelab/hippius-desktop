import { useInvokeQuery } from "./useInvokeQuery";

interface UserCreditsResponse {
  balance?: string;
}

/**
 * Fetch user credits from API
 * Returns bigint   -> balance value (scaled to 18 decimals)
 * Returns undefined -> no token or error
 */
export function useUserCredits() {
  return useInvokeQuery<UserCreditsResponse, bigint | undefined>({
    command: "get_user_credits_balance",
    queryKey: (addr) => ["user-credits", addr],
    options: {
      staleTime: Infinity,
      select: (data) => {
        const balanceStr = data.balance || "0";
        const balance = parseFloat(balanceStr) * Math.pow(10, 18);
        return BigInt(Math.floor(balance));
      },
    },
  });
}
