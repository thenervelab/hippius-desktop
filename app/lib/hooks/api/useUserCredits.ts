import { useInvokeQuery } from "./useInvokeQuery";
import { LIVE_DATA_REFRESH_MS } from "@/lib/constants";

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
 *
 * By default the balance is cached forever (`staleTime: Infinity`) — correct
 * for static/eligibility-display reads. Pass `{ live: true }` for surfaces that
 * must track charges as they happen (the low-credit warning, the home credits
 * tile): that opts into a 6s poll + focus refetch so `data` changes when the
 * balance moves, instead of showing the initial balance until a manual refresh.
 *
 * Eligibility decisions must NOT use this hook at all (see CLAUDE.md
 * credit-eligibility notes); the `live` variant is display-only.
 */
export function useUserCredits(opts?: { live?: boolean }) {
  const live = opts?.live ?? false;
  return useInvokeQuery<CreditBalanceResponse, UserCredits | undefined>({
    command: "get_user_credits",
    queryKey: (addr) => ["user-credits", addr],
    options: {
      staleTime: live ? 0 : Infinity,
      refetchInterval: live ? LIVE_DATA_REFRESH_MS : false,
      refetchOnWindowFocus: live,
      select: (resp) => ({
        planck: BigInt(resp.planck || "0"),
        hip: resp.hip,
      }),
    },
  });
}
