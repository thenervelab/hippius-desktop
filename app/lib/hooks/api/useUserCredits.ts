import { useInvokeQuery } from "./useInvokeQuery";

/**
 * Raw shape returned by Rust `get_credits`. `planck` is the 18-decimal
 * integer string (source of truth for math); `hip` is the pre-formatted
 * display string from `planck_to_hip`.
 */
interface CreditBalanceResponse {
  planck: string;
  hip: string;
}

/**
 * What consumers actually use: `planck` as `bigint` for comparisons
 * (eligibility thresholds, non-zero checks), `hip` as a ready-to-render
 * string for display.
 */
export interface UserCredits {
  planck: bigint;
  hip: string;
}

/**
 * Fetch user credits. Rust returns both the raw planck string and the
 * HIP-denominated display string in one round-trip — every credit
 * display in the app renders `data.hip` directly, no JS divmod.
 */
export function useUserCredits() {
  return useInvokeQuery<CreditBalanceResponse, UserCredits | undefined>({
    command: "get_user_credits",
    queryKey: (addr) => ["user-credits", addr],
    options: {
      staleTime: Infinity,
      select: (resp) => ({
        planck: BigInt(resp.planck || "0"),
        hip: resp.hip,
      }),
    },
  });
}
