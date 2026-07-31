"use client";

// "Review Changes" dialog — surfaces the sync engine's staged plan (uploads,
// downloads, local/remote deletes) and, when present, conflicts the user must
// resolve before the cycle proceeds.
//
// Chrome is the shared `FramedDialog` (decoration grid + brand-blue icon badge
// + centered title + close button), so light/dark theming, padding and the
// close-on-outside-click semantics match every other dialog in the app. The
// bulk resolver is the shared `SegmentedControl` — the app's canonical
// pick-one-of-N control — and each conflict's resolver is the shared
// `HomepageChartSelect`, so the controls read as first-class app UI.
//
// Layout note: conflicts lead. They are the only part of the plan that needs a
// decision, and burying them under a flat list of every upload/download/delete
// (63 delete rows in the report that prompted this) meant users scrolled past
// the actionable section to reach it. The informational sections are collapsed
// behind disclosure rows carrying their counts.
//
// This component owns no resolution state. `resolutions` is lifted to the
// caller so a closed-and-reopened dialog — or a failed sync — does not discard
// an in-progress review. See `ConflictsBanner`.

import { FC, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import FramedDialog from "@/components/ui/FramedDialog";
import HomepageChartSelect from "@/components/ui/HomepageChartSelect";
import SegmentedControl from "@/components/ui/SegmentedControl";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import type {
  StagedChanges,
  StagedConflict,
  ConflictResolution,
} from "@/lib/types/syncTypes";
import {
  applyToAll,
  areAllConflictsResolved,
  deriveBulkSelection,
  describeStagedPath,
  isEntirelyDeferred,
  type ResolutionMap,
} from "./stagedChangesLogic";

interface StagedChangesDialogProps {
  open: boolean;
  onClose: () => void;
  stagedChanges: StagedChanges | null;
  isSyncing: boolean;
  /** Controlled resolution map, owned by the caller. */
  resolutions: ResolutionMap;
  onResolutionsChange: (next: ResolutionMap) => void;
  onSync: () => void;
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
  // "Skip for now" (not "Skip"): the verb DEFERS the conflict — the engine
  // re-detects it next cycle and the banner returns. Users read a bare
  // "Skip" as "make this go away", then report the returning banner as a bug.
  { value: "skip", label: "Skip for now" },
];

const StagedChangesDialog: FC<StagedChangesDialogProps> = ({
  open,
  onClose,
  stagedChanges,
  isSyncing,
  resolutions,
  onResolutionsChange,
  onSync,
  onCancel,
}) => {
  const conflicts = useMemo(
    () => stagedChanges?.conflicts ?? [],
    [stagedChanges],
  );

  const handleResolutionChange = (
    fileId: string,
    resolution: ConflictResolution,
  ) => {
    onResolutionsChange({ ...resolutions, [fileId]: resolution });
  };

  // User explicitly cancelled — calls cancel_review to resume auto-sync. Also
  // the FramedDialog close (X / Escape / click-outside) target.
  const handleCancel = () => {
    onCancel();
    onClose();
  };

  const hasConflicts = conflicts.length > 0;
  const conflictCount = conflicts.length;
  const unchangedCount = stagedChanges?.unchanged_count ?? 0;

  // Derived, never stored: the bulk control and the per-row selects read the
  // same map, so the highlight cannot disagree with the rows.
  const bulkSelection = deriveBulkSelection(resolutions, conflicts);
  const allConflictsResolved = areAllConflictsResolved(resolutions, conflicts);
  const entirelyDeferred = isEntirelyDeferred(resolutions, conflicts);

  const totalOperations = stagedChanges
    ? stagedChanges.uploads.length +
      stagedChanges.downloads.length +
      stagedChanges.local_deletes.length +
      stagedChanges.remote_deletes.length +
      conflictCount
    : 0;

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

          {/* The plan scrolls inside the dialog so the footer buttons below
              stay reachable. `pr-3` keeps the full-width conflict rows clear
              of the scrollbar — `scrollbar-gutter` is unreliable for
              WKWebView's overlay scrollbars, which otherwise draw on top of
              the content. */}
          <div className="max-h-[420px] space-y-4 overflow-y-auto pr-3">
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

                {/* Bulk resolver. `value` is derived from the rows, so it
                    shows no active segment while they disagree instead of
                    asserting a selection that isn't real. */}
                <div className="mb-3 rounded-md border border-grey-80 bg-grey-95/40 px-3 py-2.5 dark:border-[#2c2c2c] dark:bg-[#1f1f1f]/60">
                  <span className="mb-2 block text-xs font-medium text-grey-50 dark:text-grey-dark-700">
                    Apply to all {conflictCount}
                  </span>
                  <SegmentedControl
                    ariaLabel={`Apply one resolution to all ${conflictCount} conflicts`}
                    fullWidth
                    showActiveIndicator={false}
                    options={RESOLUTION_OPTIONS}
                    value={bulkSelection}
                    onChange={(resolution) =>
                      onResolutionsChange(applyToAll(conflicts, resolution))
                    }
                    disabled={isSyncing}
                  />
                </div>

                <div className="space-y-2">
                  {conflicts.map((conflict) => (
                    <ConflictRow
                      key={conflict.file_id}
                      conflict={conflict}
                      resolution={resolutions[conflict.file_id]}
                      disabled={isSyncing}
                      onResolutionChange={(r) =>
                        handleResolutionChange(conflict.file_id, r)
                      }
                    />
                  ))}
                </div>

                {entirelyDeferred && (
                  <p className="mt-2 flex items-start gap-1.5 rounded-md border border-warning-50/40 bg-warning-50/[0.08] px-3 py-2 text-xs leading-relaxed text-grey-20 dark:text-grey-dark-800">
                    <Icons.OctagonAlert className="mt-px size-3.5 shrink-0 text-warning-50" />
                    <span>
                      Every conflict is set to <b>Skip for now</b>, so none will
                      be resolved. The rest of the plan still syncs and these
                      files will be flagged again on the next check.
                    </span>
                  </p>
                )}
              </div>
            )}

            <PlanSection
              title="Upload"
              icon="upload"
              files={stagedChanges.uploads}
              color="text-success-50"
            />
            <PlanSection
              title="Download"
              icon="download"
              files={stagedChanges.downloads}
              color="text-primary-50"
            />
            <PlanSection
              title="Delete Locally"
              icon="delete"
              files={stagedChanges.local_deletes}
              color="text-error-50"
              destructive
            />
            <PlanSection
              title="Delete from Server"
              icon="delete"
              files={stagedChanges.remote_deletes}
              color="text-error-50/70"
              destructive
            />
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
          onClick={onSync}
          loading={isSyncing}
          disabled={syncDisabled}
        >
          {isSyncing ? "Starting…" : "Sync Now"}
        </Button>
      </div>
    </FramedDialog>
  );
};

// --- Sub-components ---

/**
 * One informational part of the plan, collapsed by default.
 *
 * These sections are context, not decisions — but a build directory can put
 * dozens of rows in each, which is what pushed the conflicts off-screen. The
 * count is visible without expanding, and destructive sections carry a warning
 * edge so "63 files will be deleted from the server" is legible at a glance.
 */
function PlanSection({
  title,
  icon,
  files,
  color,
  destructive = false,
}: {
  title: string;
  icon: "upload" | "download" | "delete";
  files: { file_id: string; path: string }[];
  color: string;
  destructive?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (files.length === 0) return null;

  const IconComponent =
    icon === "upload"
      ? Icons.DocumentUpload
      : icon === "download"
        ? Icons.DocumentDownload
        : Icons.Trash;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border",
        destructive
          ? "border-error-50/30 bg-error-50/[0.04]"
          : "border-grey-80 bg-grey-95/40 dark:border-[#2c2c2c] dark:bg-[#1f1f1f]/60",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left transition-colors hover:bg-grey-90/50 dark:hover:bg-[#2c2c2c]/50"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-grey-50 transition-transform duration-200 dark:text-grey-dark-600",
            expanded && "rotate-90",
          )}
        />
        <IconComponent className={cn("size-4 shrink-0", color)} />
        <h3 className="text-sm font-semibold text-grey-10 dark:text-white">
          {title}{" "}
          <span className="font-medium text-grey-50 dark:text-grey-dark-700">
            ({files.length})
          </span>
        </h3>
      </button>

      {expanded && (
        <ul className="space-y-0.5 border-t border-grey-80 px-2 py-1.5 dark:border-[#2c2c2c]">
          {files.map((f) => (
            <li
              key={f.file_id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-grey-20 dark:text-grey-dark-800"
            >
              <Icons.Document className="size-4 shrink-0 text-grey-50 dark:text-grey-dark-600" />
              <StagedPath path={f.path} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Render a staged path, or say so when the engine could not name the file.
 *
 * The engine falls back to a hex `FileId` for files no local side-table knows
 * (see `SyncState::display_path`). Printing that in the filename column made a
 * hash look like a filename — worst of all in "Delete from Server", where the
 * user is being asked to approve the deletion.
 */
function StagedPath({ path }: { path: string }) {
  const described = describeStagedPath(path);

  if (described.kind === "path") {
    return <span className="truncate">{described.value}</span>;
  }

  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 italic text-grey-50 dark:text-grey-dark-600">
        Unknown file
      </span>
      <span
        className="truncate font-geist-mono text-xs text-grey-60 dark:text-grey-dark-600"
        title={`This device has no record of this file's name. Sync engine id: ${described.hash}`}
      >
        {described.hash.slice(0, 12)}…
      </span>
    </span>
  );
}

function ConflictRow({
  conflict,
  resolution,
  disabled,
  onResolutionChange,
}: {
  conflict: StagedConflict;
  resolution: ConflictResolution | undefined;
  disabled: boolean;
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
          <StagedPath path={conflict.path} />
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
        disabled={disabled}
      />
    </div>
  );
}

export default StagedChangesDialog;
