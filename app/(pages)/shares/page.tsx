// "My Shares" page — lists every active share-token this device's
// keystore knows about for the logged-in account, with Copy, Reshare,
// and Revoke affordances per row.
//
// Refresh strategy: TanStack Query with a 30-second `refetchInterval`
// so the list stays in step with server-side TTL expiry without the
// user reloading. Page is gated by `shareFeatureEnabledAtom` — if the
// connected hcfs-server doesn't advertise `shares: true`, we render a
// short "feature unavailable" panel instead of an empty list.
//
// Layout follows the app's standard page-sections pattern:
// `DashboardTitleWrapper` owns the sticky header (set globally in
// `ResponsiveContent`), white card rows with `AbstractIconWrapper`
// icons mirror the look of `NotificationItem`, and action buttons
// reuse the `bg-grey-90` button class shared by the rest of the app.

"use client";

import React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import { AbstractIconWrapper, Icons } from "@/components/ui";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { listShares, reshare, revokeShare, type ShareSummary } from "@/app/lib/tauri/shares";
import {
  clearShareHistory,
  listShareHistory,
  removeShareHistory,
  type HistoryEndReason,
  type ShareHistoryEntry,
} from "@/app/lib/tauri/shareHistory";
import { shareFeatureEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { formatRelative } from "@/app/lib/utils/timeRelative";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { cn } from "@/lib/utils";
import { pickHistoryRowDisplay, pickShareRowDisplay } from "./shareRowDisplay";

const SHARES_QUERY_KEY = "shares-list";
const HISTORY_QUERY_KEY = "shares-history-list";
const REFRESH_INTERVAL_MS = 30_000;

export default function MySharesPage() {
  const { polkadotAddress } = useWalletAuth();
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);
  const queryClient = useQueryClient();
  // Revoke is destructive and irreversible — the row click queues a token
  // here; `confirmRevoke` only fires after the user accepts in the
  // `ConfirmDialog`. Keeping the token (not a boolean) lets us reuse the
  // same dialog for any row without an extra "which token?" piece of state.
  const [tokenPendingRevoke, setTokenPendingRevoke] = React.useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = React.useState(false);
  // `clearAllOpen` drives the "Clear all history" confirmation dialog.
  // Single boolean (not a token carrier) because the action is global —
  // there is nothing per-row to remember while the dialog is open.
  const [clearAllOpen, setClearAllOpen] = React.useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: [SHARES_QUERY_KEY, polkadotAddress],
    queryFn: () => listShares(),
    enabled: Boolean(polkadotAddress) && shareEnabled,
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  // History is a separate query because the lists rotate at different
  // cadences (active list churns on revoke/reshare, history grows
  // monotonically until the user clears it). Same refetch interval so
  // the diff path on the Rust side can keep both surfaces in step
  // without the FE doing any cross-list bookkeeping.
  const { data: historyData } = useQuery({
    queryKey: [HISTORY_QUERY_KEY, polkadotAddress],
    queryFn: () => listShareHistory(),
    enabled: Boolean(polkadotAddress) && shareEnabled,
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  const queueRevoke = (token: string) => setTokenPendingRevoke(token);

  const confirmRevoke = async () => {
    if (!tokenPendingRevoke) return;
    setRevokeBusy(true);
    try {
      await revokeShare(tokenPendingRevoke);
      toast.success("Share revoked");
      // Refresh both lists immediately rather than waiting for the 30s
      // tick — Rust records a `RevokedHere` history entry on success, so
      // the new row would otherwise pop in late.
      queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY, polkadotAddress] });
      queryClient.invalidateQueries({ queryKey: [HISTORY_QUERY_KEY, polkadotAddress] });
    } catch (err) {
      toast.error(`Could not revoke share: ${errorMessage(err)}`);
    } finally {
      setRevokeBusy(false);
      setTokenPendingRevoke(null);
    }
  };

  const onRemoveHistory = async (token: string) => {
    try {
      await removeShareHistory(token);
      // No success toast — the row disappearing is its own confirmation.
      // Removal is a one-way action from this device's perspective:
      // the share is already dead server-side, and the diff path can't
      // re-create the row because the share is no longer in the active
      // list. Invalidate to drop the row immediately.
      queryClient.invalidateQueries({ queryKey: [HISTORY_QUERY_KEY, polkadotAddress] });
    } catch (err) {
      toast.error(`Could not remove from history: ${errorMessage(err)}`);
    }
  };

  const onReshare = async (token: string) => {
    try {
      const link = await reshare(token);
      // Auto-copy mirrors the create-share modal: the user pressed
      // Reshare *to share again*, so the new URL on the clipboard is
      // the obvious next step.
      try {
        await navigator.clipboard.writeText(link.shareUrl);
        toast.success("New link copied to clipboard");
      } catch {
        // Clipboard rejection (Safari focus rules etc.) shouldn't
        // hide the success — the row will repaint with the new URL.
        toast.success("Link reshared with a fresh expiry");
      }
      queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY, polkadotAddress] });
    } catch (err) {
      toast.error(`Could not reshare: ${errorMessage(err)}`);
    }
  };

  const onCopy = async (url: string | null) => {
    if (!url) {
      toast.error("This link was created in the console — copy it from there.");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard");
    } catch (err) {
      toast.error(`Could not copy link: ${errorMessage(err)}`);
    }
  };

  return (
    <DashboardTitleWrapper mainText="Shared Links">
      <div className="mt-4">
        {!shareEnabled && <FeatureUnavailable />}

        {shareEnabled && isLoading && (
          <div className="flex items-center gap-2 text-sm text-grey-30 p-6">
            <Loader2 className="size-4 animate-spin" />
            Loading shared links…
          </div>
        )}

        {shareEnabled && error && (
          <p className="text-sm text-error-50 p-6">Couldn&apos;t load shares: {errorMessage(error)}</p>
        )}

        {shareEnabled && !isLoading && !error && data && data.length === 0 && <EmptyState />}

        {shareEnabled && !isLoading && data && data.length > 0 && (
          <div className="flex flex-col gap-2">
            {data.map((row) => (
              <ShareRow
                key={row.shareToken}
                row={row}
                onCopy={onCopy}
                onRevoke={queueRevoke}
                onReshare={onReshare}
              />
            ))}
          </div>
        )}

        {shareEnabled && historyData && historyData.length > 0 && (
          <>
            <div className="flex items-center justify-between mt-6 mb-2">
              <h2 className="text-sm font-semibold text-grey-30">History</h2>
              <button
                onClick={() => setClearAllOpen(true)}
                className="text-xs text-grey-50 hover:text-grey-10"
              >
                Clear all history
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {historyData.map((entry) => (
                <HistoryRow
                  key={entry.shareToken}
                  entry={entry}
                  onRemove={onRemoveHistory}
                />
              ))}
            </div>
          </>
        )}

        <ConfirmDialog
          // Treating `tokenPendingRevoke !== null` as the open signal lets the
          // dialog double as a "which token are we asking about?" carrier —
          // closing it (cancel, escape, outside-click) zeroes the token in
          // `onOpenChange`, so the page settles back to a clean state.
          open={tokenPendingRevoke !== null}
          onOpenChange={(open) => {
            if (!open) setTokenPendingRevoke(null);
          }}
          variant="danger"
          title="Revoke this link?"
          description="Anyone with the link will lose access immediately. This can't be undone."
          confirmText="Revoke"
          cancelText="Cancel"
          onConfirm={confirmRevoke}
          isLoading={revokeBusy}
        />

        <ConfirmDialog
          open={clearAllOpen}
          onOpenChange={setClearAllOpen}
          variant="warning"
          title="Clear all share history?"
          description={`This removes ${historyData?.length ?? 0} entries from this device's history. The shares are already revoked or expired — this only clears the local list.`}
          confirmText="Clear history"
          cancelText="Cancel"
          onConfirm={async () => {
            try {
              await clearShareHistory();
              queryClient.invalidateQueries({ queryKey: [HISTORY_QUERY_KEY, polkadotAddress] });
            } catch (err) {
              toast.error(`Could not clear history: ${errorMessage(err)}`);
            }
          }}
        />
      </div>
    </DashboardTitleWrapper>
  );
}

interface ShareRowProps {
  row: ShareSummary;
  onCopy: (url: string | null) => void;
  onRevoke: (token: string) => void;
  onReshare: (token: string) => void;
}

function ShareRow({ row, onCopy, onRevoke, onReshare }: ShareRowProps) {
  const expiresMs = Date.parse(row.expiresAt);
  const expired = !Number.isNaN(expiresMs) && expiresMs <= Date.now();
  // Reshare needs to know the source file. The Rust IPC will reject a
  // token whose `share_origin` row is missing, but we disable the
  // button up front so the user gets a tooltip instead of a toast.
  // See `app/lib/tauri/shares.ts::reshare` for the Rust contract.
  const canReshare = Boolean(row.folderLabel && row.relativePath);
  const display = pickShareRowDisplay(row);

  return (
    <div className="flex items-center gap-3 p-3 bg-white border border-grey-80 rounded-lg hover:border-grey-70 transition-colors">
      <AbstractIconWrapper className="size-10 shrink-0">
        <Icons.Link className="absolute size-5 text-primary-50" />
      </AbstractIconWrapper>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-sm truncate",
              display.isPlaceholder
                ? "italic text-grey-50"
                : "font-medium text-grey-10",
            )}
            title={display.text}
          >
            {display.text}
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
        <p className="text-xs text-grey-50 mt-0.5">
          {formatBytes(row.plaintextSize)} · created {formatRelative(row.createdAt)} ·{" "}
          {expired ? "expired" : `expires ${formatRelative(row.expiresAt)}`}
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <RowButton
          onClick={() => onCopy(row.shareUrl)}
          disabled={!row.shareUrl}
          title={
            row.shareUrl
              ? "Copy link"
              : "This link was created in the console — copy it from there."
          }
          icon={<Icons.Copy className="size-3.5" />}
          label="Copy"
        />
        <RowButton
          onClick={() => onReshare(row.shareToken)}
          disabled={!canReshare}
          title={
            canReshare
              ? "Revoke this link and mint a new one with a fresh expiry"
              : "Reshare requires the console where this link was created."
          }
          icon={<Icons.Refresh className="size-3.5" />}
          label="Reshare"
        />
        <RowButton
          onClick={() => onRevoke(row.shareToken)}
          title="Revoke this share"
          icon={<Icons.Trash className="size-3.5" />}
          label="Revoke"
          variant="danger"
        />
      </div>
    </div>
  );
}

interface HistoryRowProps {
  entry: ShareHistoryEntry;
  onRemove: (token: string) => void;
}

/**
 * Trimmed sibling of `ShareRow` for entries that have left the active
 * list. Same icon/title/subtitle structure, but the share is dead
 * server-side so there are no Copy / Reshare / Revoke affordances —
 * only "Remove from history" to drop the row from this device's local
 * record.
 */
function HistoryRow({ entry, onRemove }: HistoryRowProps) {
  const display = pickHistoryRowDisplay(entry.filename);
  const sizeSegment =
    entry.plaintextSize !== null ? `${formatBytes(entry.plaintextSize)} · ` : "";

  return (
    <div className="flex items-center gap-3 p-3 bg-white border border-grey-80 rounded-lg hover:border-grey-70 transition-colors">
      <AbstractIconWrapper className="size-10 shrink-0">
        <Icons.Link className="absolute size-5 text-grey-40" />
      </AbstractIconWrapper>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-sm truncate",
              display.isPlaceholder
                ? "italic text-grey-50"
                : "font-medium text-grey-10",
            )}
            title={display.text}
          >
            {display.text}
          </span>
          <HistoryStatusBadge reason={entry.endReason} />
        </div>
        <p className="text-xs text-grey-50 mt-0.5">
          {sizeSegment}created {formatRelative(entry.createdAt)} ·{" "}
          {historyEndedPhrase(entry.endReason)} {formatRelative(entry.endedAt)}
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <RowButton
          onClick={() => onRemove(entry.shareToken)}
          title="Remove this entry from this device's history"
          icon={<Icons.Trash className="size-3.5" />}
          label="Remove from history"
          variant="danger"
        />
      </div>
    </div>
  );
}

/**
 * Subtitle verb for the "ended" half of a history-row subtitle. The
 * full string is composed in `HistoryRow` rather than here so the
 * caller controls placement of the trailing relative time.
 */
function historyEndedPhrase(reason: HistoryEndReason): string {
  switch (reason) {
    case "expired":
      return "expired";
    case "revoked_here":
      return "revoked";
    case "revoked_elsewhere":
      return "revoked elsewhere";
  }
}

function HistoryStatusBadge({ reason }: { reason: HistoryEndReason }) {
  // Three muted variants that match the existing `Expired` badge style
  // on `ShareRow`. Revoked-elsewhere stays grey and italic to signal
  // "this device didn't do it" — same convention as the cross-device
  // filename placeholder above.
  const baseClasses =
    "text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded";
  switch (reason) {
    case "expired":
      return <span className={cn(baseClasses, "bg-grey-90 text-grey-30")}>Expired</span>;
    case "revoked_here":
      // `error-100` is the lightest red tint in the project palette
      // (`globals.css` defines 100→10, no 95). Same role the spec calls
      // for: a soft red tint that pairs with `text-error-50`.
      return <span className={cn(baseClasses, "bg-error-100 text-error-50")}>Revoked</span>;
    case "revoked_elsewhere":
      return (
        <span className={cn(baseClasses, "bg-grey-90 text-grey-30 italic")}>
          Revoked elsewhere
        </span>
      );
  }
}

interface RowButtonProps {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  icon: React.ReactNode;
  label: string;
  /** `danger` swaps the hover accent to error tones for destructive actions. */
  variant?: "default" | "danger";
}

function RowButton({ onClick, disabled, title, icon, label, variant = "default" }: RowButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors",
        "focus:outline-none focus:ring-2",
        variant === "danger"
          ? "text-error-60 bg-grey-90 hover:bg-error-60 hover:text-white active:bg-error-70 focus:ring-error-50"
          : "text-grey-10 bg-grey-90 hover:bg-primary-50 hover:text-white active:bg-primary-70 focus:ring-primary-50",
        "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-grey-90 disabled:hover:text-grey-10"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center text-center p-12 bg-white border border-grey-80 rounded-lg">
      <AbstractIconWrapper className="size-12 mb-3">
        <Icons.Link className="absolute size-6 text-primary-50" />
      </AbstractIconWrapper>
      <h3 className="text-grey-10 font-medium text-base">No shared links</h3>
      <p className="text-xs text-grey-60 mt-1 max-w-sm">
        Right-click any synced file and choose &ldquo;Share via link&rdquo; to mint a public link. Active links
        appear here with options to copy, refresh the expiry, or revoke.
      </p>
    </div>
  );
}

function FeatureUnavailable() {
  return (
    <div className="flex flex-col items-center justify-center text-center p-12 bg-white border border-grey-80 rounded-lg">
      <AbstractIconWrapper className="size-12 mb-3">
        <Icons.Link className="absolute size-6 text-grey-40" />
      </AbstractIconWrapper>
      <h3 className="text-grey-10 font-medium text-base">File sharing unavailable</h3>
      <p className="text-xs text-grey-60 mt-1 max-w-sm">
        The connected server doesn&apos;t advertise the file-sharing capability. Update the server, or
        connect to one that supports public links.
      </p>
    </div>
  );
}

/**
 * Compact byte formatter — KB/MB/GB step, one decimal where it adds
 * resolution. Local helper because `formatBytes.ts` in `lib/utils`
 * uses a different verbose style ("1.50 megabytes") that doesn't fit
 * the narrow row layout.
 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
