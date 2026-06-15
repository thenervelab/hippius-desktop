import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useWalletAuth } from "@/lib/wallet-auth-context";

/** Default "last uploads" count — matches the console's limit. */
const RECENT_UPLOADS_LIMIT = 7;

/**
 * Account-wide "last uploads" for the sidebar search palette.
 *
 * Wraps the `get_recent_uploads` Rust command, which fetches the most recent
 * uploads from the HCFS server's `/search_files` endpoint (sorted by
 * `created_at` desc) — the same endpoint and params the web console's "Last
 * Uploads" uses. Unlike `useRecentFiles` (this device's sync-activity log,
 * empty on a fresh launch) it reflects every upload on the account, including
 * those made from other devices. Returns the same `FormattedUserFile` shape
 * as the search results so the palette renders both with one row component.
 */
export function useRecentUploads(limit: number = RECENT_UPLOADS_LIMIT) {
  const { polkadotAddress } = useWalletAuth();

  return useQuery({
    queryKey: ["recent-uploads", polkadotAddress, limit],
    queryFn: async (): Promise<FormattedUserFile[]> => {
      if (!polkadotAddress) return [];
      return invoke<FormattedUserFile[]>("get_recent_uploads", {
        accountId: polkadotAddress,
        limit,
      });
    },
    enabled: !!polkadotAddress,
    // Short window so the palette shows fresh uploads on reopen without
    // refetching on every focus flicker.
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

export default useRecentUploads;
