"use client";

import { FC, useState, useMemo, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "@/components/ui/DialogContainer";
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
    resolution: ConflictResolution
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

  // User explicitly cancelled — calls cancel_review to resume auto-sync
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

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) handleCancel();
      }}
    >
      <DialogContainer className="sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:max-w-[640px] sm:max-h-[80vh] sm:bottom-auto sm:right-auto">
        <Dialog.Title className="sr-only">Review Staged Changes</Dialog.Title>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-grey-80">
          <div className="flex items-center gap-2">
            <Icons.Document className="size-5 text-primary-50" />
            <h2 className="text-base font-semibold text-grey-10">
              Review Changes
            </h2>
          </div>
          <button
            onClick={handleCancel}
            className="p-1 rounded hover:bg-grey-90 transition-colors"
          >
            <Icons.CloseCircle className="size-5 text-grey-40" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto max-h-[60vh] px-4 py-3">
          {!stagedChanges ? (
            <div className="flex items-center justify-center py-8">
              <Icons.Loader className="size-6 animate-spin text-primary-60" />
              <span className="ml-2 text-grey-40">Loading changes...</span>
            </div>
          ) : totalOperations === 0 ? (
            <div className="text-center py-8 text-grey-40">
              <p className="text-sm">Everything is in sync.</p>
              <p className="text-xs mt-1">
                {stagedChanges.unchanged_count} file
                {stagedChanges.unchanged_count !== 1 ? "s" : ""} unchanged
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Uploads */}
              <FileSection
                title="Upload"
                icon="upload"
                files={stagedChanges.uploads}
                color="text-green-600"
              />

              {/* Downloads */}
              <FileSection
                title="Download"
                icon="download"
                files={stagedChanges.downloads}
                color="text-blue-600"
              />

              {/* Local Deletes */}
              <FileSection
                title="Delete Locally"
                icon="delete"
                files={stagedChanges.local_deletes}
                color="text-red-500"
              />

              {/* Remote Deletes */}
              <FileSection
                title="Delete from Server"
                icon="delete"
                files={stagedChanges.remote_deletes}
                color="text-orange-500"
              />

              {/* Conflicts */}
              {hasConflicts && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <Icons.OctagonAlert className="size-4 text-yellow-600" />
                      <h3 className="text-sm font-medium text-grey-10">
                        Conflicts ({stagedChanges.conflicts.length})
                      </h3>
                    </div>
                    {/* Apply all buttons */}
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-grey-40">Apply all:</span>
                      {RESOLUTION_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => handleApplyAll(opt.value)}
                          className="text-xs px-1.5 py-0.5 rounded bg-grey-90 border border-grey-80 text-grey-30 hover:bg-primary-50 hover:text-white hover:border-primary-50 transition-colors"
                        >
                          {opt.label}
                        </button>
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
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-grey-80">
          <span className="text-xs text-grey-40">
            {stagedChanges
              ? `${stagedChanges.unchanged_count} unchanged file${stagedChanges.unchanged_count !== 1 ? "s" : ""}`
              : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCancel}
              disabled={isSyncing}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded border border-grey-80 bg-grey-100 text-grey-10 transition-colors",
                isSyncing
                  ? "opacity-50 cursor-not-allowed"
                  : "hover:bg-grey-90"
              )}
            >
              Cancel
            </button>
            <button
              onClick={handleSync}
              disabled={
                isSyncing ||
                !stagedChanges ||
                totalOperations === 0 ||
                (hasConflicts && !allConflictsResolved)
              }
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded text-white transition-colors",
                isSyncing ||
                  !stagedChanges ||
                  totalOperations === 0 ||
                  (hasConflicts && !allConflictsResolved)
                  ? "bg-primary-50/50 cursor-not-allowed"
                  : "bg-primary-50 hover:bg-primary-40"
              )}
            >
              {isSyncing ? (
                <span className="flex items-center gap-1.5">
                  <Icons.Loader className="size-3.5 animate-spin" />
                  Syncing...
                </span>
              ) : (
                "Sync Now"
              )}
            </button>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
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
      <div className="flex items-center gap-1.5 mb-1.5">
        <IconComponent className={cn("size-4", color)} />
        <h3 className="text-sm font-medium text-grey-10">
          {title} ({files.length})
        </h3>
      </div>
      <div className="space-y-0.5">
        {files.map((f) => (
          <div
            key={f.file_id}
            className="flex items-center gap-2 px-2 py-1 rounded bg-grey-95 text-sm text-grey-20"
          >
            <Icons.Document className="size-3.5 text-grey-50 shrink-0" />
            <span className="truncate">{f.path}</span>
          </div>
        ))}
      </div>
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
    <div className="flex items-center justify-between gap-3 px-2 py-2 rounded bg-yellow-50/30 border border-yellow-200/50">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-grey-10 truncate">{conflict.path}</p>
        <p className="text-xs text-grey-40">
          {CONFLICT_TYPE_LABELS[conflict.conflict_type] || conflict.conflict_type}
        </p>
      </div>
      <select
        value={resolution || ""}
        onChange={(e) =>
          onResolutionChange(e.target.value as ConflictResolution)
        }
        className={cn(
          "text-xs px-2 py-1 rounded border bg-grey-100 text-grey-10 focus:outline-none focus:ring-1 focus:ring-primary-50",
          resolution ? "border-primary-50" : "border-yellow-400"
        )}
      >
        <option value="" disabled>
          Choose...
        </option>
        {RESOLUTION_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default StagedChangesDialog;
