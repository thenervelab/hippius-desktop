// "My Shares" page — lists every active share-token this device's
// keystore knows about for the logged-in account, with Copy and
// Revoke affordances per row.
//
// Refresh strategy: TanStack Query with a 30-second `refetchInterval`
// so the list stays in step with server-side TTL expiry without the
// user reloading. Page is gated by `shareFeatureEnabledAtom` — if the
// connected hcfs-server doesn't advertise `shares: true`, we render a
// short "feature unavailable" message instead of an empty list.

"use client";

import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Copy, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { listShares, revokeShare, type ShareSummary } from "@/app/lib/tauri/shares";
import { shareFeatureEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

const SHARES_QUERY_KEY = "shares-list";
const REFRESH_INTERVAL_MS = 30_000;

export default function MySharesPage() {
  const { polkadotAddress } = useWalletAuth();
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: [SHARES_QUERY_KEY, polkadotAddress],
    queryFn: () => listShares(),
    enabled: Boolean(polkadotAddress) && shareEnabled,
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  const onRevoke = async (token: string) => {
    try {
      await revokeShare(token);
      toast.success("Share revoked");
      // Refresh immediately rather than waiting for the 30s tick.
      queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY, polkadotAddress] });
    } catch (err) {
      toast.error(`Could not revoke share: ${errorMessage(err)}`);
    }
  };

  const onCopy = async (url: string | null) => {
    if (!url) {
      toast.error("This share's key is not on this device — copy it from the device that created it.");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard");
    } catch (err) {
      toast.error(`Could not copy link: ${errorMessage(err)}`);
    }
  };

  if (!shareEnabled) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-medium text-grey-10 mb-2">My Shares</h1>
        <p className="text-sm text-grey-30">File sharing is not enabled on this server.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-medium text-grey-10 mb-4">My Shares</h1>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-grey-30">
          <Loader2 className="size-4 animate-spin" />
          Loading shares…
        </div>
      )}

      {error && <p className="text-sm text-error-50">Couldn&apos;t load shares: {errorMessage(error)}</p>}

      {!isLoading && !error && data && data.length === 0 && (
        <p className="text-sm text-grey-30">You haven&apos;t shared any files yet.</p>
      )}

      {!isLoading && data && data.length > 0 && (
        <ul className="divide-y divide-grey-80 border border-grey-80 rounded">
          {data.map((row) => (
            <ShareRow key={row.shareToken} row={row} onCopy={onCopy} onRevoke={onRevoke} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface ShareRowProps {
  row: ShareSummary;
  onCopy: (url: string | null) => void;
  onRevoke: (token: string) => void;
}

function ShareRow({ row, onCopy, onRevoke }: ShareRowProps) {
  const expiresMs = Date.parse(row.expiresAt);
  const expired = !Number.isNaN(expiresMs) && expiresMs <= Date.now();
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-grey-10 truncate" title={row.filename}>
            {row.filename}
          </span>
          {expired && (
            // Server reaps in the background — render the badge
            // immediately so the user sees the right state without
            // waiting for the next refresh cycle.
            <span className="text-[10px] font-medium uppercase tracking-wide bg-grey-90 text-grey-30 px-1.5 py-0.5 rounded">
              Expired
            </span>
          )}
        </div>
        <p className="text-xs text-grey-30 mt-0.5">
          {formatBytes(row.plaintextSize)} · created {formatRelative(row.createdAt)} ·{" "}
          {expired ? "expired" : `expires ${formatRelative(row.expiresAt)}`}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onCopy(row.shareUrl)}
          disabled={!row.shareUrl}
          title={row.shareUrl ? "Copy link" : "Key not on this device"}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-grey-30 hover:text-grey-10 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Copy className="size-3.5" />
          Copy
        </button>
        <button
          onClick={() => onRevoke(row.shareToken)}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-error-50 hover:text-error-60"
        >
          <Trash2 className="size-3.5" />
          Revoke
        </button>
      </div>
    </li>
  );
}

/**
 * Compact byte formatter — KB/MB/GB step, one decimal where it adds
 * resolution. Local helper because `formatBytes.ts` in `lib/utils`
 * uses a different verbose style ("1.50 megabytes") that doesn't
 * fit the narrow row layout.
 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Render an RFC 3339 timestamp as a coarse "in 4h" / "12m ago" string.
 * Returns the original string if unparseable so a wire-format change
 * upstream doesn't blank the row.
 */
function formatRelative(rfc3339: string): string {
  const ms = Date.parse(rfc3339);
  if (Number.isNaN(ms)) return rfc3339;
  const diffMs = ms - Date.now();
  const abs = Math.abs(diffMs);
  const future = diffMs > 0;
  if (abs < 60_000) return future ? "in <1m" : "<1m ago";
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.round(abs / 86_400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}
