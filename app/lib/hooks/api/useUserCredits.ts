import { useInvokeQuery } from "./useInvokeQuery";

/**
 * Fetch user credits as planck BigInt (18 decimals).
 * Rust converts the decimal string to planck without float intermediary,
 * avoiding precision loss on large balances.
 */
export function useUserCredits() {
  return useInvokeQuery<string, bigint | undefined>({
    command: "get_credits_planck",
    queryKey: (addr) => ["user-credits", addr],
    options: {
      staleTime: Infinity,
      select: (planck) => BigInt(planck || "0"),
    },
  });
}
