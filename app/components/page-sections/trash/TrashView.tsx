"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreVertical, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import PageHeader from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select/Select";
import ConfirmationDialog from "@/app/components/ConfirmationDialog";
import TableActionMenu, { type ActionItem } from "@/app/components/ui/alt-table/TableActionMenu";
import NameClashDialog from "@/components/page-sections/drive/move/NameClashDialog";
import type { Clash, ClashAnswers } from "@/app/lib/drive-move/runMove";
import { getFileIcon } from "@/lib/utils/fileTypeUtils";
import { getFileTypeFromExtension } from "@/app/lib/utils/getTileTypeFromExtension";
import { formatBytes } from "@/lib/utils/formatBytes";
import { cn } from "@/lib/utils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { driveFolderRoute } from "@/app/lib/routes";
import { useTrashShortcuts, isTypingTarget } from "@/app/lib/hooks/useTrashShortcuts";
import {
  deleteTrashItemsForever,
  emptyTrash,
  listTrash,
  newTrashJobId,
  onTrashProgress,
  restoreTrashItems,
  type RestoreChoice,
  type TrashProgress,
  type TrashRow,
} from "@/app/lib/tauri/trash";
import {
  DELETE_FOREVER_BUTTON,
  DELETE_FOREVER_TITLE,
  EMPTY_TRASH_BUTTON,
  EMPTY_TRASH_TITLE,
  deleteForeverText,
  daysUntilDeleted,
  deletedExact,
  deletedForeverIn,
  deletedForeverPhrase,
  emptyTrashNote,
  emptyTrashText,
  itemCount,
  locationOf,
  progressMessage,
  restoredMessage,
  retentionDays,
  retentionNotice,
} from "@/app/lib/trash/copy";
import { clashDestinationName, rowKey, sizeLabel } from "./trashRows";

export const TRASH_QUERY_KEY = "drive-trash";
const ALL_DRIVES = "__all__";
const NO_DELETE_REASON = "Only the drive's owner or a manager can delete forever.";

/** Six columns from `lg` up; name, a meta line and the menu below it. */
const GRID =
  "grid items-center gap-x-3 grid-cols-[20px_minmax(0,1fr)_auto] lg:grid-cols-[20px_minmax(0,2.2fr)_minmax(0,1.5fr)_112px_88px_64px]";

/**
 * Drive Trash: every item deleted from this account's drives and the drives
 * shared with it. The server deletes each one forever after the retention
 * (`retentionDays`, 30 by default) unless it is restored or deleted forever
 * sooner; the app never purges. Rust lists,
 * restores and deletes (`src-tauri/src/sync/fileops/trash`); this page is
 * the list, the selection and the questions.
 */
export default function TrashView() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { polkadotAddress } = useWalletAuth();
  const [drive, setDrive] = useState<string>(ALL_DRIVES);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ kind: "forever"; rows: TrashRow[] } | { kind: "empty" } | null>(null);
  const [clashes, setClashes] = useState<{ rows: TrashRow[]; request: { clashes: Clash[]; destinationName: string; noReplace: boolean } } | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useQuery({
    queryKey: [TRASH_QUERY_KEY, polkadotAddress],
    queryFn: () => listTrash(polkadotAddress as string),
    enabled: Boolean(polkadotAddress),
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const listing = query.data;

  // The drive filter shows only when Trash holds items from more than one.
  const drivesWithItems = useMemo(() => {
    const labels = new Set(listing?.items.map((r) => r.label) ?? []);
    return (listing?.drives ?? []).filter((d) => labels.has(d.label));
  }, [listing]);
  useEffect(() => {
    if (drive !== ALL_DRIVES && !drivesWithItems.some((d) => d.label === drive)) setDrive(ALL_DRIVES);
  }, [drive, drivesWithItems]);

  const rows = useMemo(
    () => (listing?.items ?? []).filter((r) => drive === ALL_DRIVES || r.label === drive),
    [listing, drive],
  );
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(rowKey(r))), [rows, selected]);
  // A row that left the list (restored elsewhere, deleted) leaves the selection.
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(rows.map(rowKey));
      const next = new Set([...prev].filter((k) => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const emptiable = rows.filter((r) => r.canDeleteForever);
  const retention = retentionDays(listing?.retentionDays);
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: [TRASH_QUERY_KEY] });
    if (polkadotAddress) await notifyFilesMutated(queryClient, polkadotAddress);
  }, [queryClient, polkadotAddress]);

  /** Run one Trash call with a loading toast that follows Rust's progress. */
  const withProgress = useCallback(
    async <T,>(
      action: TrashProgress["action"],
      count: number,
      run: (jobId: string) => Promise<T>,
    ): Promise<{ result: T; toastId: string | number }> => {
      const jobId = newTrashJobId();
      const toastId = toast.loading(progressMessage(action === "trash" ? "delete" : action, null, count));
      const stop = await onTrashProgress(jobId, (p) =>
        toast.loading(progressMessage(action === "trash" ? "delete" : action, p, count), { id: toastId }),
      ).catch(() => null);
      try {
        return { result: await run(jobId), toastId };
      } catch (err) {
        toast.error("Something went wrong", { id: toastId, description: errorMessage(err) });
        throw err;
      } finally {
        stop?.();
      }
    },
    [],
  );

  const restore = useCallback(
    async (targets: TrashRow[], answers?: Map<string, RestoreChoice>) => {
      if (!polkadotAddress || targets.length === 0 || busy) return;
      setBusy(true);
      try {
        const { result, toastId } = await withProgress("restore", targets.length, (jobId) =>
          restoreTrashItems(
            polkadotAddress,
            jobId,
            targets.map((r) => ({
              label: r.label,
              itemId: r.itemId,
              path: r.path,
              isFolder: r.isFolder,
              fileCount: r.fileCount,
              onClash: answers?.get(rowKey(r)) ?? "ask",
            })),
          ),
        );
        const byKey = new Map(targets.map((r) => [rowKey(r), r] as const));
        const restored = result.filter((r) => r.status === "restored");
        const clashed = result.filter((r) => r.status === "clash").map((r) => byKey.get(`${r.label}::${r.itemId}`)!).filter(Boolean);
        const failed = result.filter((r) => r.status === "failed" || r.status === "notFound");
        setSelected(new Set());

        if (restored.length > 0) {
          const first = restored[0];
          const firstRow = byKey.get(`${first.label}::${first.itemId}`);
          const name = first.path.split("/").pop() ?? first.path;
          // "Show": the folder it went back to, with it pointed out.
          const canShow = restored.length === 1 && firstRow && !firstRow.label.startsWith("shared:");
          toast.success(restoredMessage([name], restored.length), {
            id: toastId,
            description: failed.length > 0 ? `${itemCount(failed.length)} couldn't be restored.` : undefined,
            action: canShow
              ? {
                  label: "Show",
                  onClick: () => {
                    const parent = first.path.includes("/") ? first.path.slice(0, first.path.lastIndexOf("/")) : undefined;
                    router.push(driveFolderRoute(firstRow.label, !firstRow.synced, parent, name));
                  },
                }
              : undefined,
          });
        } else if (failed.length > 0) {
          toast.error(failed.length === 1 ? "Couldn't restore it" : `Couldn't restore ${itemCount(failed.length)}`, {
            id: toastId,
            description: failed[0].error ?? undefined,
          });
        } else {
          toast.dismiss(toastId);
        }
        if (clashed.length > 0) {
          setClashes({
            rows: clashed,
            request: {
              clashes: clashed.map((r) => ({ item: { path: rowKey(r), name: r.name, isFolder: r.isFolder }, takenByFolder: false })),
              destinationName: clashDestinationName(clashed),
              noReplace: true,
            },
          });
        }
      } catch {
        // The toast already says what went wrong.
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [polkadotAddress, busy, withProgress, refresh, router],
  );

  const onClashAnswered = useCallback(
    (answers: ClashAnswers | null) => {
      const pending = clashes;
      setClashes(null);
      if (!pending || !answers) return;
      const choices = new Map<string, RestoreChoice>();
      for (const row of pending.rows) {
        const answer = answers.get(rowKey(row));
        choices.set(rowKey(row), answer === "keepBoth" ? "keepBoth" : "skip");
      }
      const again = pending.rows.filter((r) => choices.get(rowKey(r)) === "keepBoth");
      if (again.length > 0) void restore(again, choices);
    },
    [clashes, restore],
  );

  const deleteForever = useCallback(
    async (targets: TrashRow[]) => {
      if (!polkadotAddress || targets.length === 0) return;
      setBusy(true);
      try {
        const { result, toastId } = await withProgress("delete", targets.length, (jobId) =>
          deleteTrashItemsForever(
            polkadotAddress,
            jobId,
            targets.map((r) => ({ label: r.label, itemId: r.itemId })),
          ),
        );
        setSelected(new Set());
        if (result.failed.length > 0 && result.deleted === 0) {
          toast.error("Couldn't delete them", { id: toastId, description: result.failed[0] });
        } else {
          toast.success(result.deleted === 1 && targets.length === 1 ? `Deleted “${targets[0].name}”` : `Deleted ${itemCount(result.deleted)}`, {
            id: toastId,
            description: result.failed[0],
          });
        }
      } catch {
        // Said by the toast.
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [polkadotAddress, withProgress, refresh],
  );

  const empty = useCallback(async () => {
    if (!polkadotAddress) return;
    const labels = [...new Set(emptiable.map((r) => r.label))];
    if (labels.length === 0) return;
    setBusy(true);
    try {
      const { result, toastId } = await withProgress("empty", emptiable.length, (jobId) => emptyTrash(polkadotAddress, jobId, labels));
      setSelected(new Set());
      if (result.failed.length > 0) toast.warning("Trash was partly emptied", { id: toastId, description: result.failed[0] });
      else toast.success("Trash emptied", { id: toastId });
    } catch {
      // Said by the toast.
    } finally {
      setBusy(false);
      await refresh();
    }
  }, [polkadotAddress, emptiable, withProgress, refresh]);

  const toggle = useCallback((row: TrashRow) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = rowKey(row);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const askDeleteForever = useCallback(
    (targets: TrashRow[]) => {
      if (targets.length === 0 || busy) return;
      if (targets.some((r) => !r.canDeleteForever)) {
        toast.error(NO_DELETE_REASON);
        return;
      }
      setConfirm({ kind: "forever", rows: targets });
    },
    [busy],
  );

  // Escape clears the selection; Cmd+A (Ctrl+A) selects every row; the
  // delete keys ask "Delete forever?" for the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || confirm || clashes) return;
      if (e.key === "Escape" && selected.size > 0) {
        setSelected(new Set());
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && rows.length > 0) {
        e.preventDefault();
        setSelected(new Set(rows.map(rowKey)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selected.size, confirm, clashes]);
  useTrashShortcuts({
    enabled: selectedRows.length > 0 && !confirm && !clashes,
    onTrash: () => askDeleteForever(selectedRows),
    onForever: () => askDeleteForever(selectedRows),
  });

  const header = (
    <PageHeader
      hideStats
      title="Trash"
      className="!shadow-none"
      actions={
        <>
          {drivesWithItems.length > 1 && (
            <div className="w-[160px] sm:w-[200px]">
              <Select
                ariaLabel="Drive"
                value={drive}
                onValueChange={setDrive}
                options={[
                  { value: ALL_DRIVES, label: "All drives" },
                  ...drivesWithItems.map((d) => ({ value: d.label, label: d.name })),
                ]}
              />
            </div>
          )}
          <Button
            variant="raised"
            size="sm"
            className="h-8 whitespace-nowrap px-3 text-sm"
            disabled={busy || emptiable.length === 0}
            onClick={() => setConfirm({ kind: "empty" })}
          >
            Empty trash
          </Button>
        </>
      }
    />
  );

  return (
    <div className="flex min-w-0 flex-col">
      {header}
      <div className={cn("flex flex-col gap-3 px-4", selectedRows.length > 0 ? "pb-28" : "pb-8")}>
        {listing?.incomplete && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-grey-50 dark:text-grey-dark-600">
            <span>Some drives&apos; Trash couldn&apos;t be read.</span>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="rounded font-medium text-primary-50 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-primary-brand-dark"
            >
              Try again
            </button>
          </div>
        )}

        {rows.length > 0 && <p className="text-sm text-grey-50 dark:text-grey-dark-600">{retentionNotice(retention)}</p>}

        {query.isLoading ? (
          <TrashSkeleton />
        ) : query.isError ? (
          <StateCard
            title="Couldn't load Trash"
            action={
              <Button variant="raised" size="sm" className="h-8 px-3 text-sm" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <StateCard icon title="Trash is empty" note={emptyTrashNote(retention)} />
        ) : (
          <div
            role="table"
            aria-label="Trash"
            className="overflow-hidden rounded-lg border border-grey-80 bg-white dark:border-[#2c2c2c] dark:bg-[#111111]"
          >
            <div
              role="row"
              className={cn(
                GRID,
                "border-b border-grey-80 px-3 py-2 text-xs font-medium uppercase tracking-[0.04em] text-grey-50 dark:border-[#2c2c2c] dark:text-grey-dark-600",
              )}
            >
              <span role="columnheader">
                <input
                  type="checkbox"
                  aria-label={allSelected ? "Clear selection" : "Select all"}
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedRows.length > 0 && !allSelected;
                  }}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(rowKey)))}
                  className="size-4 cursor-pointer accent-primary-50"
                />
              </span>
              <span role="columnheader">Name</span>
              <span role="columnheader" className="hidden lg:block">
                Location
              </span>
              <span role="columnheader" className="hidden lg:block">
                Deleted forever
              </span>
              <span role="columnheader" className="hidden text-right lg:block">
                Size
              </span>
              <span role="columnheader" className="sr-only lg:not-sr-only" />
            </div>
            {rows.map((row) => (
              <TrashListRow
                key={rowKey(row)}
                row={row}
                retention={retention}
                selected={selected.has(rowKey(row))}
                busy={busy}
                onToggle={toggle}
                onRestore={(r) => void restore([r])}
                onDeleteForever={(r) => askDeleteForever([r])}
              />
            ))}
          </div>
        )}
      </div>

      {selectedRows.length > 0 && (
        <div className="fixed bottom-8 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
          <div
            role="toolbar"
            aria-label="Selected items"
            className="flex items-center justify-between gap-2 rounded-full bg-primary-50 px-4 py-2 text-grey-100 shadow-lg"
          >
            <span className="min-w-0 truncate text-sm font-medium">{selectedRows.length} selected</span>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="!text-grey-100 hover:!text-grey-90"
                disabled={busy}
                onClick={() => setSelected(new Set())}
              >
                Cancel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="flex items-center gap-1 whitespace-nowrap !text-grey-100 hover:!text-grey-90"
                disabled={busy}
                onClick={() => void restore(selectedRows)}
                aria-label="Restore"
              >
                <RotateCcw className="size-4" />
                <span className="max-sm:hidden">Restore</span>
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="flex items-center gap-1 whitespace-nowrap !text-grey-100 hover:!text-error-70"
                disabled={busy || selectedRows.some((r) => !r.canDeleteForever)}
                title={selectedRows.some((r) => !r.canDeleteForever) ? NO_DELETE_REASON : undefined}
                onClick={() => askDeleteForever(selectedRows)}
                aria-label={DELETE_FOREVER_BUTTON}
              >
                <Trash2 className="size-4" />
                <span className="max-sm:hidden">{DELETE_FOREVER_BUTTON}</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmationDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onBack={() => setConfirm(null)}
        onConfirm={() => {
          const pending = confirm;
          setConfirm(null);
          if (pending?.kind === "forever") void deleteForever(pending.rows);
          else if (pending?.kind === "empty") void empty();
        }}
        heading={confirm?.kind === "empty" ? EMPTY_TRASH_TITLE : DELETE_FOREVER_TITLE}
        text={
          confirm?.kind === "empty"
            ? emptyTrashText(emptiable.length)
            : deleteForeverText(confirm?.kind === "forever" ? confirm.rows.map((r) => r.name) : [])
        }
        button={confirm?.kind === "empty" ? EMPTY_TRASH_BUTTON : DELETE_FOREVER_BUTTON}
        icon={<Trash2 className="size-[18px] text-white" strokeWidth={2.5} />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        disableButton={busy}
      />

      <NameClashDialog request={clashes?.request ?? null} onDone={onClashAnswered} />
    </div>
  );
}

function TrashListRow({
  row,
  retention,
  selected,
  busy,
  onToggle,
  onRestore,
  onDeleteForever,
}: {
  row: TrashRow;
  retention: number;
  selected: boolean;
  busy: boolean;
  onToggle: (row: TrashRow) => void;
  onRestore: (row: TrashRow) => void;
  onDeleteForever: (row: TrashRow) => void;
}) {
  const location = locationOf(row.driveName, row.parentPath);
  const days = daysUntilDeleted(row, retention);
  const exact = `Moved to Trash ${deletedExact(row.trashedAt)}`;
  const type = row.isFolder ? undefined : getFileTypeFromExtension(row.name.includes(".") ? (row.name.split(".").pop() ?? null) : null);
  const { icon: Icon, color } = getFileIcon(type ?? undefined, row.isFolder);
  const items: ActionItem[] = [
    {
      icon: <RotateCcw className="size-4" />,
      itemTitle: "Restore",
      disabled: busy,
      onItemClick: () => onRestore(row),
    },
    {
      icon: <Trash2 className="size-4" />,
      itemTitle: DELETE_FOREVER_BUTTON,
      variant: "destructive",
      disabled: busy || !row.canDeleteForever,
      tooltip: row.canDeleteForever ? undefined : NO_DELETE_REASON,
      onItemClick: () => onDeleteForever(row),
    },
  ];

  return (
    <div
      role="row"
      aria-selected={selected}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, input, [role='menu']")) return;
        onToggle(row);
      }}
      className={cn(
        GRID,
        "group cursor-default border-b border-grey-90 px-3 py-2.5 text-sm last:border-b-0 dark:border-[#1f1f1f]",
        selected ? "bg-primary-50/[0.06] dark:bg-primary-brand-dark/10" : "hover:bg-grey-95 dark:hover:bg-white/[0.03]",
      )}
    >
      <span role="cell">
        <input
          type="checkbox"
          aria-label={`Select ${row.name}`}
          checked={selected}
          onChange={() => onToggle(row)}
          className="size-4 cursor-pointer accent-primary-50"
        />
      </span>
      <span role="cell" className="flex min-w-0 items-center gap-2.5">
        <Icon className={cn("size-5 shrink-0", color)} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-grey-10 dark:text-grey-light-100" title={row.name}>
            {row.name}
          </span>
          {/* Below `lg` the other columns fold into one muted line. */}
          <span className="truncate text-xs text-grey-50 dark:text-grey-dark-600 lg:hidden" title={`${location} · ${exact}`}>
            {location} · {deletedForeverPhrase(days)}
          </span>
        </span>
      </span>
      <span role="cell" className="hidden truncate text-grey-50 dark:text-grey-dark-600 lg:block" title={location}>
        {location}
      </span>
      <span role="cell" className="hidden truncate text-grey-50 dark:text-grey-dark-600 lg:block" title={exact}>
        {deletedForeverIn(days)}
      </span>
      <span role="cell" className="hidden text-right tabular-nums text-grey-50 dark:text-grey-dark-600 lg:block">
        {sizeLabel(row, formatBytes)}
      </span>
      <span role="cell" className="flex items-center justify-end gap-1">
        <button
          type="button"
          aria-label={`Restore ${row.name}`}
          title="Restore"
          disabled={busy}
          onClick={() => onRestore(row)}
          className="hidden size-7 items-center justify-center rounded-md text-grey-50 opacity-0 transition-opacity hover:bg-grey-90 hover:text-grey-10 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-50 disabled:cursor-not-allowed group-hover:opacity-100 dark:text-grey-dark-600 dark:hover:bg-white/10 dark:hover:text-white lg:flex"
        >
          <RotateCcw className="size-4" />
        </button>
        <TableActionMenu dropdownTitle="" items={items}>
          <Button
            variant="ghost"
            size="auto"
            aria-label={`More for ${row.name}`}
            className="h-7 w-7 p-0 text-grey-50 hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-grey-dark-600 dark:hover:text-white"
          >
            <MoreVertical className="size-4" />
          </Button>
        </TableActionMenu>
      </span>
    </div>
  );
}

function TrashSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading Trash"
      className="overflow-hidden rounded-lg border border-grey-80 bg-white dark:border-[#2c2c2c] dark:bg-[#111111]"
    >
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className={cn(GRID, "border-b border-grey-90 px-3 py-3 last:border-b-0 dark:border-[#1f1f1f]")}>
          <span className="size-4 rounded bg-grey-90 dark:bg-white/10" />
          <span className="flex items-center gap-2.5">
            <span className="size-5 shrink-0 animate-pulse rounded bg-grey-90 dark:bg-white/10" />
            <span className="h-3.5 w-2/3 animate-pulse rounded bg-grey-90 dark:bg-white/10" />
          </span>
          <span className="hidden h-3.5 w-1/2 animate-pulse rounded bg-grey-90 dark:bg-white/10 lg:block" />
          <span className="hidden h-3.5 w-16 animate-pulse rounded bg-grey-90 dark:bg-white/10 lg:block" />
          <span className="hidden h-3.5 w-12 justify-self-end animate-pulse rounded bg-grey-90 dark:bg-white/10 lg:block" />
          <span className="size-4 justify-self-end rounded bg-grey-90 dark:bg-white/10" />
        </div>
      ))}
    </div>
  );
}

function StateCard({ title, note, icon = false, action }: { title: string; note?: string; icon?: boolean; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-grey-80 px-4 py-16 text-center dark:border-[#2c2c2c]">
      {icon && (
        <span className="flex size-12 items-center justify-center rounded-full bg-grey-95 text-grey-50 dark:bg-white/5 dark:text-grey-dark-600">
          <Trash2 className="size-5" strokeWidth={1.6} />
        </span>
      )}
      <p className="text-base font-medium text-grey-10 dark:text-grey-light-100">{title}</p>
      {note && <p className="-mt-2 text-sm text-grey-50 dark:text-grey-dark-600">{note}</p>}
      {action}
    </div>
  );
}
