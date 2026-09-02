// "Sync Issues" dialog — surfaces files that hcfs-client has retried
// past the FILES_FAILED_REPEATEDLY threshold and given up on. The
// user is offered three escape hatches per file: retry now, skip for
// this session, or permanently exclude from sync.
//
// Chrome is the shared `FramedDialog` (decoration grid + icon badge +
// centered title + close button), so light/dark theming, padding,
// and the close-on-outside-click semantics match every other dialog
// in the app. Buttons are the shared `Button` UI primitive so the
// hover / active / corner-dot motion is consistent app-wide.
//
// Bulk actions appear once there are 2+ items — most users with a
// storm of failures want all-or-nothing, and per-row buttons alone
// force them to click N times. Bulk Retry/Skip fire immediately
// (non-destructive); bulk Exclude routes through ConfirmDialog
// because it's both destructive and irreversible from this surface.

"use client";

import { useCallback, useState } from "react";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import FramedDialog from "@/components/ui/FramedDialog";
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

// (label, path) is the unique pair the Rust IPC keys on; mirror it
// locally so optimistic-remove and per-row "in flight" tracking stay
// aligned across re-renders.
function rowKey(file: FailedFileInfo): string {
  return `${file.label}/${file.path}`;
}

export default function FailedFilesModal() {
  const [failedFiles, setFailedFiles] = useAtom(failedFilesAtom);
  const open = failedFiles !== null && failedFiles.length > 0;
  // Per-row action in flight — keys are `rowKey(file)`. Disables that
  // row's buttons so a double-click can't fire the same IPC twice and
  // a slow IPC can't leave the user wondering whether their click
  // registered.
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
      // allSettled so a single Rust failure (e.g. file already removed
      // upstream) doesn't drop the rest. Failures get rolled into a
      // single error toast so the user isn't spammed.
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

  // Dismiss is remembered in Rust: a dismissed file stays quiet however long
  // it keeps failing, and across restarts; the dialog only returns when a
  // file the user has not seen reaches the threshold. Retry, Skip and
  // Exclude forget the dismissal. The atom is cleared first so the dialog
  // closes at once; a failed write only means it may return next cycle.
  const handleDismiss = useCallback(() => {
    const files = (failedFiles ?? []).map(({ label, path }) => ({
      label,
      path,
    }));
    setFailedFiles(null);
    if (files.length === 0) return;
    invoke("sp_dismiss_failed_files", { files }).catch((err: unknown) =>
      console.warn("Failed to record dismissed sync issues:", err),
    );
  }, [failedFiles, setFailedFiles]);

  const count = failedFiles?.length ?? 0;
  const showBulkActions = count >= 2;

  return (
    <>
      <FramedDialog
        // Hide this dialog while the "Exclude all" confirm is up so the two
        // don't stack. Setting `open` to false programmatically does NOT fire
        // Radix's `onOpenChange`, so `handleDismiss` is not called and the
        // failed-files list survives — it reappears when the confirm closes.
        open={open && !excludeAllOpen}
        onClose={handleDismiss}
        title="Sync Issues"
        // Frame + icon badge use the destructive coral (#fc7d73) — the same
        // colour as the Exclude / Exclude-all buttons and the exclude-confirm
        // dialog — so the whole "Sync Issues" surface reads as one consistent
        // destructive family. The single hex renders identically in light/dark.
        icon={<AlertTriangle className="size-5 text-white" />}
        iconBgClassName="bg-[#fc7d73]"
        borderClassName="bg-[#fc7d73]"
        maxWidth="max-w-[685px]"
        cardClassName="bg-white dark:bg-[#161616]"
      >
        <p className="mb-5 text-center text-sm font-medium leading-5 text-grey-50 dark:text-grey-dark-700">
          {count === 1
            ? "1 file failed to sync after multiple attempts. Choose to retry, skip, or permanently exclude it."
            : `${count} files failed to sync after multiple attempts. Choose to retry, skip, or permanently exclude each.`}
        </p>

        {showBulkActions && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-grey-80 bg-grey-95/40 px-3 py-2 dark:border-[#2c2c2c] dark:bg-[#1f1f1f]/60">
            <span className="text-xs font-medium text-grey-50 dark:text-grey-dark-700">
              Apply to all {count} files:
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="defaultStable"
                size="sm"
                onClick={() => runBulk("retry")}
                disabled={bulkBusy}
              >
                Retry all
              </Button>
              <Button
                variant="defaultStable"
                size="sm"
                onClick={() => runBulk("skip")}
                disabled={bulkBusy}
              >
                Skip all
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="text-white"
                onClick={() => setExcludeAllOpen(true)}
                disabled={bulkBusy}
              >
                Exclude all
              </Button>
            </div>
          </div>
        )}

        {/* File list. Cap inside the dialog so the FramedDialog scrollable
            content area never has to scroll for the chrome — only the
            file list itself scrolls when there are many failures. */}
        <div className="mb-5 max-h-[22rem] overflow-y-auto rounded-md border border-grey-80 bg-grey-95/40 dark:border-[#2c2c2c] dark:bg-[#1f1f1f]/60 [scrollbar-gutter:stable]">
          {failedFiles?.map((file, idx) => (
            <FileRow
              key={rowKey(file)}
              file={file}
              busy={inFlight.has(rowKey(file))}
              onAction={runAction}
              isLast={idx === count - 1}
            />
          ))}
        </div>

        <Button
          // `defaultStable` keeps the rounded-md shape on hover — the
          // `default` variant morphs to a pill, which reads wrong on
          // a full-width footer button.
          variant="defaultStable"
          className={cn(
            "h-[52px] w-full border border-[#e3e3e3] !bg-transparent text-grey-10",
            "hover:!bg-grey-90",
            "dark:border-[#494949] dark:!bg-transparent dark:text-white dark:hover:!bg-[#2c2c2c]",
          )}
          onClick={handleDismiss}
        >
          Dismiss
        </Button>
      </FramedDialog>

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
    </>
  );
}

interface FileRowProps {
  file: FailedFileInfo;
  busy: boolean;
  onAction: (file: FailedFileInfo, action: Action) => void;
  isLast: boolean;
}

function FileRow({ file, busy, onAction, isLast }: FileRowProps) {
  const { fileFormat } = getFilePartsFromFileName(file.fileName);
  const fileType = getFileTypeFromExtension(fileFormat || null) ?? undefined;
  const { icon: Icon, color } = getFileIcon(fileType, false);

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-3 transition-opacity",
        !isLast && "border-b border-grey-80 dark:border-[#2c2c2c]",
        busy && "opacity-60",
      )}
    >
      <Icon className={cn("size-5 shrink-0", color)} />

      <div className="flex-1 min-w-0">
        <MiddleTruncatedName
          name={file.fileName}
          className="text-sm font-medium text-grey-10 dark:text-white"
        />
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-grey-50 dark:text-grey-dark-600">
          <span className="truncate">{file.error || "Sync failed"}</span>
          <span className="text-grey-70 dark:text-grey-dark-400">·</span>
          <span className="shrink-0 rounded bg-grey-90 px-1.5 py-0.5 font-medium text-grey-30 dark:bg-[#2c2c2c] dark:text-grey-dark-800">
            {file.label}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="defaultStable"
          size="sm"
          onClick={() => onAction(file, "retry")}
          disabled={busy}
        >
          Retry
        </Button>
        <Button
          variant="defaultStable"
          size="sm"
          onClick={() => onAction(file, "skip")}
          disabled={busy}
        >
          Skip
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="text-white"
          onClick={() => onAction(file, "exclude")}
          // Title is the only signal that Exclude is irreversible — bulk
          // exclude routes through ConfirmDialog, per-row does not.
          title="Permanently exclude this file from sync"
          disabled={busy}
        >
          Exclude
        </Button>
      </div>
    </div>
  );
}
