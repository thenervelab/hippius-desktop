// "Sync Issues" dialog — surfaces files that hcfs-client has retried
// past the FILES_FAILED_REPEATEDLY threshold and given up on. The
// user is offered three escape hatches per file: retry now, skip for
// this session, or permanently exclude from sync.
//
// Design notes:
// - Uses the shared `DialogContainer` with the center-on-desktop /
//   bottom-sheet-on-mobile pattern, matching ShareFileModal and
//   ConfirmDialog. The original implementation was bottom-pinned
//   even on desktop, which read as a notification toast rather than
//   a modal action surface.
// - Sticky header and footer so a long failure list (50+ files) stays
//   navigable without losing the page-level context or the Dismiss
//   button. The list itself scrolls inside a fixed max-height.
// - Bulk actions appear once there are 2+ items — most users with a
//   storm of failures want all-or-nothing, and per-row buttons alone
//   force them to click N times. Bulk Retry/Skip fire immediately
//   (non-destructive); bulk Exclude routes through ConfirmDialog
//   because it's both destructive and irreversible from this surface.
// - Per-row buttons remain inline (rather than a 3-dot menu) because
//   triage is the common case here — hiding actions behind an extra
//   click defeats the dialog's purpose. Compact text labels with
//   destructive-styled Exclude keep the visual hierarchy clear.

"use client";

import { useCallback, useState } from "react";
import { useAtom } from "jotai";
import * as Dialog from "@radix-ui/react-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { AlertTriangle, X } from "lucide-react";

import DialogContainer from "@/components/ui/DialogContainer";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";
import { failedFilesAtom, type FailedFileInfo } from "@/lib/store/syncAtoms";
import { getFileIcon } from "@/lib/utils/fileTypeUtils";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { getFilePartsFromFileName } from "@/lib/utils";
import { cn } from "@/lib/utils";

type Action = "retry" | "skip" | "exclude";

const ACTION_TO_COMMAND: Record<Action, string> = {
  retry: "sp_retry_file",
  skip: "sp_skip_file",
  exclude: "sp_exclude_file",
};

const ACTION_TO_TOAST: Record<Action, string> = {
  retry: "File will retry on next sync cycle",
  skip: "File skipped for this session",
  exclude: "File permanently excluded from sync",
};

/**
 * Stable identity key for a failed file. (label, path) is the unique
 * pair the Rust IPC keys on, and we use the same shape locally so
 * optimistic-remove and per-row "in flight" tracking stay aligned.
 */
function rowKey(file: FailedFileInfo): string {
  return `${file.label}/${file.path}`;
}

export default function FailedFilesModal() {
  const [failedFiles, setFailedFiles] = useAtom(failedFilesAtom);
  const open = failedFiles !== null && failedFiles.length > 0;
  // Per-row action in flight — keys are `rowKey(file)`. Disables that
  // row's buttons and shows a subtle pending state so a double-click
  // can't fire the same IPC twice and a slow IPC can't leave the user
  // wondering whether their click registered.
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  const [excludeAllOpen, setExcludeAllOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const removeFromList = useCallback(
    (predicate: (file: FailedFileInfo) => boolean) => {
      setFailedFiles((prev) => {
        if (!prev) return null;
        const next = prev.filter((f) => !predicate(f));
        return next.length > 0 ? next : null;
      });
    },
    [setFailedFiles],
  );

  const runAction = useCallback(
    async (file: FailedFileInfo, action: Action) => {
      const key = rowKey(file);
      // Bail if this row already has an action in flight — prevents the
      // "click Retry, then click Skip a beat later" race that would
      // double-IPC and double-toast.
      if (inFlight.has(key)) return;
      setInFlight((prev) => new Set(prev).add(key));
      try {
        await invoke(ACTION_TO_COMMAND[action], {
          label: file.label,
          path: file.path,
        });
        toast.success(ACTION_TO_TOAST[action], { duration: 4000 });
        removeFromList((f) => f.label === file.label && f.path === file.path);
      } catch (err) {
        toast.error(`Failed to ${action} file: ${err}`);
      } finally {
        setInFlight((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [inFlight, removeFromList],
  );

  const runBulk = useCallback(
    async (action: Action) => {
      const targets = failedFiles ?? [];
      if (targets.length === 0) return;
      setBulkBusy(true);
      // Fire all IPC calls in parallel — each one is independent, and
      // sequential awaits on a 50-file storm would feel laggy. We use
      // allSettled so a single Rust failure (e.g. file already removed
      // upstream) doesn't drop the rest. Any failures get rolled into
      // a single error toast at the end so the user isn't spammed.
      const results = await Promise.allSettled(
        targets.map((file) =>
          invoke(ACTION_TO_COMMAND[action], {
            label: file.label,
            path: file.path,
          }),
        ),
      );
      const succeeded: FailedFileInfo[] = [];
      const failed: { file: FailedFileInfo; error: unknown }[] = [];
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          succeeded.push(targets[i]);
        } else {
          failed.push({ file: targets[i], error: result.reason });
        }
      });
      if (succeeded.length > 0) {
        const succeededKeys = new Set(succeeded.map(rowKey));
        removeFromList((f) => succeededKeys.has(rowKey(f)));
        toast.success(
          `${succeeded.length} ${succeeded.length === 1 ? "file" : "files"} ${
            action === "retry"
              ? "will retry on next sync"
              : action === "skip"
                ? "skipped for this session"
                : "permanently excluded"
          }`,
          { duration: 4000 },
        );
      }
      if (failed.length > 0) {
        toast.error(
          `${failed.length} ${failed.length === 1 ? "file" : "files"} could not be ${action === "exclude" ? "excluded" : action === "skip" ? "skipped" : "retried"}`,
        );
      }
      setBulkBusy(false);
      setExcludeAllOpen(false);
    },
    [failedFiles, removeFromList],
  );

  const handleDismiss = useCallback(() => {
    setFailedFiles(null);
  }, [setFailedFiles]);

  const count = failedFiles?.length ?? 0;
  const showBulkActions = count >= 2;

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && handleDismiss()}>
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[36rem] h-fit">
        <Dialog.Title className="sr-only">Sync Issues</Dialog.Title>
        <Dialog.Description className="sr-only">
          Files that have failed to sync after multiple attempts. Choose
          to retry, skip, or permanently exclude each.
        </Dialog.Description>

        {/* Mobile accent bar — matches ShareFileModal / ConfirmDialog */}
        <div className="h-2 bg-warning-50 md:hidden" />

        {/* Header. items-center pairs the icon with the title+subtitle
            block as a single vertically-centered unit, instead of
            top-aligning the icon and leaving a visual jog when the
            subtitle wraps. Tight `leading-tight` + `mt-0.5` keeps the
            two text lines visually paired rather than reading as two
            separate paragraphs. */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-grey-80">
          <div className="size-10 rounded-lg bg-warning-90 flex items-center justify-center shrink-0">
            <AlertTriangle className="size-5 text-warning-50" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-grey-10 leading-tight">
              Sync Issues
            </h2>
            <p className="text-xs text-grey-50 leading-tight mt-0.5">
              {count === 1
                ? "1 file failed to sync after multiple attempts."
                : `${count} files failed to sync after multiple attempts.`}
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Close"
            className="shrink-0 p-1 rounded text-grey-50 hover:text-grey-10 hover:bg-grey-90 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-50"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Bulk actions — only when triaging more than one file is
            actually faster than per-row clicks. */}
        {showBulkActions && (
          <div className="flex items-center justify-between gap-2 px-5 py-3 bg-grey-90 border-b border-grey-80">
            <span className="text-xs text-grey-50">Apply to all {count} files:</span>
            <div className="flex items-center gap-2">
              <BulkButton
                onClick={() => runBulk("retry")}
                disabled={bulkBusy}
                tone="default"
              >
                Retry all
              </BulkButton>
              <BulkButton
                onClick={() => runBulk("skip")}
                disabled={bulkBusy}
                tone="default"
              >
                Skip all
              </BulkButton>
              <BulkButton
                onClick={() => setExcludeAllOpen(true)}
                disabled={bulkBusy}
                tone="danger"
              >
                Exclude all
              </BulkButton>
            </div>
          </div>
        )}

        {/* Scrollable list. Cap the list (not the whole dialog) so the
            header and footer always stay visible — the alternative
            (flex + min-h-0) requires the parent to have a defined
            height, which `h-fit` doesn't provide.

            `scrollbar-gutter: stable` reserves space for the scrollbar
            even when the content fits without scrolling, so the file
            rows' right edge always lines up with the bulk-actions row
            and the footer. Without it the scrollbar consumes ~14px on
            the right of overflowing rows, pushing per-row buttons left
            of the bulk Exclude all / Dismiss buttons stacked above and
            below them. */}
        <div className="max-h-[24rem] overflow-y-auto custom-scrollbar-thin [scrollbar-gutter:stable]">
          {failedFiles?.map((file) => (
            <FileRow
              key={rowKey(file)}
              file={file}
              busy={inFlight.has(rowKey(file))}
              onAction={runAction}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-grey-80">
          <button
            type="button"
            onClick={handleDismiss}
            className="px-4 py-2 text-sm font-medium rounded border border-grey-80 bg-grey-100 text-grey-10 hover:bg-grey-90 active:bg-grey-80 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-50"
          >
            Dismiss
          </button>
        </div>
      </DialogContainer>

      <ConfirmDialog
        open={excludeAllOpen}
        onOpenChange={(open) => !open && setExcludeAllOpen(false)}
        variant="danger"
        title={`Exclude ${count} ${count === 1 ? "file" : "files"} from sync?`}
        description="These files will be permanently excluded from sync on this device. You can re-add them later by editing the exclude list in Settings."
        confirmText="Exclude all"
        cancelText="Cancel"
        onConfirm={() => runBulk("exclude")}
        isLoading={bulkBusy}
      />
    </Dialog.Root>
  );
}

interface FileRowProps {
  file: FailedFileInfo;
  busy: boolean;
  onAction: (file: FailedFileInfo, action: Action) => void;
}

function FileRow({ file, busy, onAction }: FileRowProps) {
  const { fileFormat } = getFilePartsFromFileName(file.fileName);
  const fileType = getFileTypeFromExtension(fileFormat || null) ?? undefined;
  const { icon: Icon, color } = getFileIcon(fileType, false);

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-5 py-3 border-b border-grey-80 last:border-b-0 transition-opacity",
        busy && "opacity-60",
      )}
    >
      {/* Icon flush-left so its visual left edge lines up with the
          "Apply to all" label and the page header above. The previous
          size-8 centering wrapper added a 6px offset because a size-5
          icon centered inside a size-8 box leaves 6px on each side. */}
      <Icon className={cn("size-5 shrink-0", color)} />

      <div className="flex-1 min-w-0">
        <MiddleTruncatedName
          name={file.fileName}
          className="text-sm font-medium text-grey-10"
        />
        <div className="flex items-center gap-1.5 mt-0.5 text-xs text-grey-50 min-w-0">
          <span className="truncate">{file.error || "Sync failed"}</span>
          <span className="text-grey-70">·</span>
          <span className="shrink-0 px-1.5 py-0.5 rounded bg-grey-90 text-grey-30 font-medium">
            {file.label}
          </span>
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-1.5">
        <RowButton
          onClick={() => onAction(file, "retry")}
          disabled={busy}
          tone="default"
        >
          Retry
        </RowButton>
        <RowButton
          onClick={() => onAction(file, "skip")}
          disabled={busy}
          tone="default"
        >
          Skip
        </RowButton>
        <RowButton
          onClick={() => onAction(file, "exclude")}
          disabled={busy}
          tone="danger"
          title="Permanently exclude this file from sync"
        >
          Exclude
        </RowButton>
      </div>
    </div>
  );
}

interface ButtonProps {
  onClick: () => void;
  disabled?: boolean;
  tone: "default" | "danger";
  title?: string;
  children: React.ReactNode;
}

/**
 * Per-row action button. `tone="danger"` swaps the hover state to a
 * destructive red so the user has a clear visual distinction between
 * the safe Retry/Skip and the irreversible Exclude.
 */
function RowButton({ onClick, disabled, tone, title, children }: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "px-2.5 py-1 text-xs font-medium rounded border transition-colors focus:outline-none focus-visible:ring-2 disabled:opacity-50 disabled:cursor-not-allowed",
        tone === "danger"
          ? "border-error-90 text-error-50 hover:bg-error-50 hover:text-white hover:border-error-50 active:bg-error-60 focus-visible:ring-error-50"
          : "border-grey-80 bg-grey-90 text-grey-10 hover:bg-primary-50 hover:text-white hover:border-primary-50 active:bg-primary-70 focus-visible:ring-primary-50",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Bulk action button. Same visual contract as `RowButton` but slightly
 * larger so the bulk row reads as the "primary path" when there are
 * many failures.
 */
function BulkButton({ onClick, disabled, tone, children }: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "px-3 py-1.5 text-xs font-medium rounded border transition-colors focus:outline-none focus-visible:ring-2 disabled:opacity-50 disabled:cursor-not-allowed",
        tone === "danger"
          ? "border-error-90 text-error-50 bg-grey-100 hover:bg-error-50 hover:text-white hover:border-error-50 active:bg-error-60 focus-visible:ring-error-50"
          : "border-grey-80 bg-grey-100 text-grey-10 hover:bg-primary-50 hover:text-white hover:border-primary-50 active:bg-primary-70 focus-visible:ring-primary-50",
      )}
    >
      {children}
    </button>
  );
}
