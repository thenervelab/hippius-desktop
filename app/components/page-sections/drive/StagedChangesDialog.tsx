"use client";

// "Review Changes" dialog — surfaces the sync engine's staged plan (uploads,
// downloads, local/remote deletes) and, when present, conflicts the user must
// resolve before the cycle proceeds.
//
// Chrome is the shared `FramedDialog` (decoration grid + brand-blue icon badge
// + centered title + close button), so light/dark theming, padding and the
// close-on-outside-click semantics match every other dialog in the app — the
// same treatment as the sibling `FailedFilesModal`. All buttons are the shared
// `Button` primitive and each conflict's resolver is the shared
// `HomepageChartSelect` (the chart-card filter dropdown), so the controls read
// as first-class app UI instead of raw HTML `<button>`/`<select>`.

import { FC, useState, useMemo, useEffect } from "react";

import { Button } from "@/components/ui/button";
import FramedDialog from "@/components/ui/FramedDialog";
import HomepageChartSelect from "@/components/ui/HomepageChartSelect";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import type {
  StagedChanges,
  StagedConflict,
  ConflictResolution,
} from "@/lib/types/syncTypes";

interface StagedChangesDialogProps {
  open: boolean;
  onClose: () => void;
  stagedChanges: StagedChanges | null;
  isSyncing: boolean;
  onSync: (resolutions: Record<string, ConflictResolution>) => void;
  onCancel: () => void;
}

const CONFLICT_TYPE_LABELS: Record<string, string> = {
  modify_modify: "Both modified",
  modify_delete: "Modified locally, deleted remotely",
  delete_modify: "Deleted locally, modified remotely",
  create_create: "Both created",
};

const RESOLUTION_OPTIONS: { value: ConflictResolution; label: string }[] = [
  { value: "keep_local", label: "Keep Local" },
  { value: "accept_remote", label: "Accept Remote" },
  { value: "keep_both", label: "Keep Both" },
  { value: "skip", label: "Skip" },
];

// Distinct Button variant per bulk action so the "Apply to all" row reads at a
// glance instead of four identical greys. The two symmetric "pick a side"
// choices deliberately SHARE the neutral grey (giving them different colours
// would wrongly imply one is preferred); "Keep Both" — the safe, no-data-loss
// option — gets the brand-blue tint; "Skip" (defer) is the lightest, ghost
// treatment.
const APPLY_ALL_VARIANTS: Record<
  ConflictResolution,
  "defaultStable" | "primaryLight" | "ghost"
> = {
  keep_local: "defaultStable",
  accept_remote: "defaultStable",
  keep_both: "primaryLight",
  skip: "ghost",
};

const StagedChangesDialog: FC<StagedChangesDialogProps> = ({
  open,
  onClose,
  stagedChanges,
  isSyncing,
  onSync,
  onCancel,
}) => {
  const [resolutions, setResolutions] = useState<
    Record<string, ConflictResolution>
  >({});

  // Reset resolutions when staged changes update (new dialog open or data refresh)
  useEffect(() => {
    setResolutions({});
  }, [stagedChanges]);

  const handleResolutionChange = (
    fileId: string,
    resolution: ConflictResolution,
  ) => {
    setResolutions((prev) => ({ ...prev, [fileId]: resolution }));
  };

  const handleApplyAll = (resolution: ConflictResolution) => {
    if (!stagedChanges) return;
    const all: Record<string, ConflictResolution> = {};
    for (const c of stagedChanges.conflicts) {
      all[c.file_id] = resolution;
    }
    setResolutions(all);
  };

  const handleSync = () => {
    onSync(resolutions);
  };

  // User explicitly cancelled — calls cancel_review to resume auto-sync. Also
  // the FramedDialog close (X / Escape / click-outside) target.
  const handleCancel = () => {
    onCancel();
    setResolutions({});
    onClose();
  };

  const hasConflicts = (stagedChanges?.conflicts.length ?? 0) > 0;

  const allConflictsResolved = useMemo(() => {
    if (!stagedChanges || stagedChanges.conflicts.length === 0) return true;
    return stagedChanges.conflicts.every((c) => resolutions[c.file_id]);
  }, [stagedChanges, resolutions]);

  const totalOperations = stagedChanges
    ? stagedChanges.uploads.length +
      stagedChanges.downloads.length +
      stagedChanges.local_deletes.length +
      stagedChanges.remote_deletes.length +
      stagedChanges.conflicts.length
    : 0;

  const conflictCount = stagedChanges?.conflicts.length ?? 0;
  const unchangedCount = stagedChanges?.unchanged_count ?? 0;

  const syncDisabled =
    isSyncing ||
    !stagedChanges ||
    totalOperations === 0 ||
    (hasConflicts && !allConflictsResolved);

  return (
    <FramedDialog
      open={open}
      onClose={handleCancel}
      title="Review Changes"
      icon={<Icons.Document className="size-5 text-white" />}
      iconBgClassName="bg-primary-50"
      borderClassName="bg-primary-50"
      maxWidth="max-w-[640px]"
      cardClassName="bg-white dark:bg-[#161616]"
    >
      {!stagedChanges ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-grey-50 dark:text-grey-dark-700">
          <Icons.Loader className="size-5 animate-spin text-primary-50" />
          Loading changes…
        </div>
      ) : totalOperations === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm font-medium text-grey-10 dark:text-white">
            Everything is in sync.
          </p>
          <p className="mt-1 text-xs text-grey-50 dark:text-grey-dark-700">
            {unchangedCount} file{unchangedCount !== 1 ? "s" : ""} unchanged
          </p>
        </div>
      ) : (
        <>
          <p className="mb-5 text-center text-sm font-medium leading-5 text-grey-50 dark:text-grey-dark-700">
            {hasConflicts
              ? `Review the staged changes and resolve ${conflictCount === 1 ? "the conflict" : `all ${conflictCount} conflicts`} before syncing.`
              : "Review the staged changes below before syncing."}
          </p>

          {/* The change plan scrolls inside the dialog so the footer buttons
              below stay reachable even with a long list. `pr-3` keeps the
              full-width conflict rows clear of the scrollbar — `scrollbar-gutter`
              is unreliable for WKWebView's overlay scrollbars, which otherwise
              draw on top of the content. */}
          <div className="max-h-[420px] space-y-4 overflow-y-auto pr-3">
            <FileSection
              title="Upload"
              icon="upload"
              files={stagedChanges.uploads}
              color="text-success-50"
            />
            <FileSection
              title="Download"
              icon="download"
              files={stagedChanges.downloads}
              color="text-primary-50"
            />
            <FileSection
              title="Delete Locally"
              icon="delete"
              files={stagedChanges.local_deletes}
              color="text-error-50"
            />
            <FileSection
              title="Delete from Server"
              icon="delete"
              files={stagedChanges.remote_deletes}
              color="text-error-50/70"
            />

            {hasConflicts && (
              <div>
                <div className="mb-2 flex items-center gap-1.5">
                  <Icons.OctagonAlert className="size-4 shrink-0 text-warning-50" />
                  <h3 className="text-sm font-semibold text-grey-10 dark:text-white">
                    Conflicts{" "}
                    <span className="font-medium text-grey-50 dark:text-grey-dark-700">
                      ({conflictCount})
                    </span>
                  </h3>
                </div>

                {/* Bulk resolver bar — mirrors FailedFilesModal's "apply to
                    all" row so the two conflict surfaces feel identical. */}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-grey-80 bg-grey-95/40 px-3 py-2 dark:border-[#2c2c2c] dark:bg-[#1f1f1f]/60">
                  <span className="text-xs font-medium text-grey-50 dark:text-grey-dark-700">
                    Apply to all {conflictCount}:
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {RESOLUTION_OPTIONS.map((opt) => (
                      <Button
                        key={opt.value}
                        variant={APPLY_ALL_VARIANTS[opt.value]}
                        size="sm"
                        dotSize={3}
                        // Smaller than the default `sm` (h-9 / text-sm): these
                        // are compact bulk shortcuts, not primary actions.
                        className={cn(
                          "h-7 px-2.5 text-xs",
                          // The ghost "Skip" has no fill of its own — give it an
                          // outline + hover so it reads as a button (the lightest
                          // of the four) instead of plain text.
                          opt.value === "skip" &&
                            "rounded-md border border-grey-80 text-grey-50 hover:bg-grey-90 dark:border-[#494949] dark:text-grey-dark-700 dark:hover:bg-[#2c2c2c]",
                        )}
                        onClick={() => handleApplyAll(opt.value)}
                        disabled={isSyncing}
                      >
                        {opt.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  {stagedChanges.conflicts.map((conflict) => (
                    <ConflictRow
                      key={conflict.file_id}
                      conflict={conflict}
                      resolution={resolutions[conflict.file_id]}
                      onResolutionChange={(r) =>
                        handleResolutionChange(conflict.file_id, r)
                      }
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Footer */}
      <div className="mt-5 flex items-center gap-3">
        <Button
          variant="defaultStable"
          className={cn(
            "h-[52px] flex-1 border border-[#e3e3e3] !bg-transparent text-grey-10",
            "hover:!bg-grey-90",
            "dark:border-[#494949] dark:!bg-transparent dark:text-white dark:hover:!bg-[#2c2c2c]",
          )}
          onClick={handleCancel}
          disabled={isSyncing}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          className="h-[52px] flex-1"
          onClick={handleSync}
          loading={isSyncing}
          disabled={syncDisabled}
        >
          {isSyncing ? "Syncing…" : "Sync Now"}
        </Button>
      </div>
    </FramedDialog>
  );
};

// --- Sub-components ---

function FileSection({
  title,
  icon,
  files,
  color,
}: {
  title: string;
  icon: "upload" | "download" | "delete";
  files: { file_id: string; path: string }[];
  color: string;
}) {
  if (files.length === 0) return null;

  const IconComponent =
    icon === "upload"
      ? Icons.DocumentUpload
      : icon === "download"
        ? Icons.DocumentDownload
        : Icons.Trash;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <IconComponent className={cn("size-4 shrink-0", color)} />
        <h3 className="text-sm font-semibold text-grey-10 dark:text-white">
          {title}{" "}
          <span className="font-medium text-grey-50 dark:text-grey-dark-700">
            ({files.length})
          </span>
        </h3>
      </div>
      <ul className="space-y-0.5">
        {files.map((f) => (
          <li
            key={f.file_id}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-grey-20 dark:text-grey-dark-800"
          >
            <Icons.Document className="size-4 shrink-0 text-grey-50 dark:text-grey-dark-600" />
            <span className="truncate">{f.path}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConflictRow({
  conflict,
  resolution,
  onResolutionChange,
}: {
  conflict: StagedConflict;
  resolution: ConflictResolution | undefined;
  onResolutionChange: (r: ConflictResolution) => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 transition-colors",
        "bg-grey-95/40 dark:bg-[#1f1f1f]/60",
        // Unresolved conflicts carry a subtle amber edge so the user can see
        // at a glance which rows still gate the Sync Now button; resolved rows
        // fall back to the neutral border.
        resolution
          ? "border-grey-80 dark:border-[#2c2c2c]"
          : "border-warning-50/40",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-grey-10 dark:text-white">
          {conflict.path}
        </p>
        <p className="mt-0.5 text-xs text-grey-50 dark:text-grey-dark-600">
          {CONFLICT_TYPE_LABELS[conflict.conflict_type] ||
            conflict.conflict_type}
        </p>
      </div>
      <HomepageChartSelect
        options={RESOLUTION_OPTIONS}
        value={resolution ?? ""}
        onValueChange={(v) => onResolutionChange(v as ConflictResolution)}
        placeholder="Choose…"
        className="w-[160px] shrink-0"
      />
    </div>
  );
}

export default StagedChangesDialog;
