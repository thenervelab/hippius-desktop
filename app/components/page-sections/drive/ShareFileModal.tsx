// Modal that creates a public share link for a synced file.
//
// Lifecycle:
//
//   `running`  — `hcfs_create_share` IPC in flight. Spinner + filename.
//   `done`     — link is ready. Read-only URL with an inline copy
//                button, auto-copied to clipboard, Open / Close /
//                Revoke actions.
//   `error`    — IPC failed. Inline error message + Try again / Close.
//
// We picked a coarse three-state machine over per-byte progress because
// hcfs-client's share API does not expose a progress callback in v1
// (see `docs/plans/2026-04-28-file-sharing-design.md`). Faking smooth
// percentages would be a UX trap.

"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAtom } from "jotai";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { Button, Icons } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { cn } from "@/lib/utils";
import { shareModalFileAtom } from "@/app/lib/global-atoms/sharesAtoms";
import {
  createShare,
  revokeShare,
  type ShareLink,
} from "@/app/lib/tauri/shares";
import { errorMessage } from "@/app/lib/utils/errorUtils";

type ModalState =
  | { kind: "running" }
  | { kind: "done"; link: ShareLink }
  | { kind: "error"; message: string };

export default function ShareFileModal() {
  const [file, setFile] = useAtom(shareModalFileAtom);
  const [state, setState] = useState<ModalState>({ kind: "running" });
  // Auto-copy fires once per `done` transition. Reopening the dialog
  // without closing must not double-copy a stale URL.
  const autoCopiedRef = useRef(false);

  const filename = file?.actualFileName || file?.name || "";
  const folderLabel = file?.label;

  const close = useCallback(() => setFile(null), [setFile]);

  const startShare = useCallback(async () => {
    if (!file || !folderLabel) return;
    setState({ kind: "running" });
    autoCopiedRef.current = false;
    try {
      // `actualFileName` is the relative path inside the sync folder
      // (e.g. `subdir/file.txt`); see `FormattedUserFile`. The fallback
      // to `name` mirrors `revealInFileManager` in the file row's
      // context menu.
      const relativePath = file.actualFileName || file.name;
      const link = await createShare(folderLabel, relativePath);
      setState({ kind: "done", link });
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
    }
  }, [file, folderLabel]);

  // Kick off the share when the modal opens.
  useEffect(() => {
    if (file) startShare();
  }, [file, startShare]);

  // Auto-copy once we reach `done`. The URL is still rendered in a
  // selectable textbox so the user can re-copy if focus rules block
  // the auto-copy (Safari) or if they just want to verify the value.
  useEffect(() => {
    if (state.kind !== "done") return;
    if (autoCopiedRef.current) return;
    autoCopiedRef.current = true;
    navigator.clipboard
      .writeText(state.link.shareUrl)
      .then(() => toast.success("Link copied to clipboard"))
      .catch((err: unknown) => {
        // Auto-copy is best-effort; clipboard rejection (Safari focus
        // rules, etc.) shouldn't break the modal.
        console.warn("[ShareFileModal] auto-copy failed:", err);
      });
  }, [state]);

  if (!file) return null;

  const onCopy = async () => {
    if (state.kind !== "done") return;
    try {
      await navigator.clipboard.writeText(state.link.shareUrl);
      toast.success("Link copied to clipboard");
    } catch (err) {
      toast.error(`Could not copy link: ${errorMessage(err)}`);
    }
  };

  const onOpenInBrowser = async () => {
    if (state.kind !== "done") return;
    try {
      await openUrl(state.link.shareUrl);
    } catch (err) {
      toast.error(`Could not open link: ${errorMessage(err)}`);
    }
  };

  const onRevoke = async () => {
    if (state.kind !== "done") return;
    try {
      await revokeShare(state.link.shareToken);
      toast.success("Share link revoked");
      close();
    } catch (err) {
      toast.error(`Could not revoke share link: ${errorMessage(err)}`);
    }
  };

  return (
    <FramedDialog
      open
      onClose={close}
      title="Share via link"
      icon={<Icons.Link className="size-4 text-white" />}
      maxWidth="max-w-[585px]"
    >
      {state.kind === "running" && (
        <RunningBody filename={filename} onCancel={close} />
      )}

      {state.kind === "done" && (
        <DoneBody
          link={state.link}
          onCopy={onCopy}
          onOpen={onOpenInBrowser}
          onClose={close}
          onRevoke={onRevoke}
        />
      )}

      {state.kind === "error" && (
        <ErrorBody
          message={state.message}
          onRetry={startShare}
          onClose={close}
        />
      )}
    </FramedDialog>
  );
}

function RunningBody({
  filename,
  onCancel,
}: {
  filename: string;
  onCancel: () => void;
}) {
  return (
    <div className="font-geist">
      <div className="mb-6 flex flex-col items-center gap-3">
        <Loader2 className="size-6 animate-spin text-primary-50" />
        <div className="flex flex-col items-center gap-1 px-2 text-center">
          <p className="text-sm font-medium text-grey-20 dark:text-grey-dark-800">
            Encrypting and uploading…
          </p>
          <p
            className="font-mono text-xs text-grey-50 dark:text-grey-dark-600 break-all"
            title={filename}
          >
            {filename}
          </p>
        </div>
      </div>

      <Button
        type="button"
        variant="defaultStable"
        size="auto"
        onClick={onCancel}
        className="h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]"
      >
        Cancel
      </Button>
    </div>
  );
}

function ErrorBody({
  message,
  onRetry,
  onClose,
}: {
  message: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="font-geist">
      <div className="mb-6 flex items-start gap-2 rounded-md border border-error-90 bg-error-100/40 px-3 py-2.5 dark:border-error-30/60 dark:bg-error-30/10">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-error-70" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-error-70">
            Couldn&apos;t create share link
          </p>
          <p className="mt-1 break-words text-xs text-grey-50 dark:text-grey-dark-600">
            {message}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Button
          type="button"
          variant="primary"
          size="auto"
          onClick={onRetry}
          className={cn(
            "h-[52px] w-full rounded-[6px] border text-base font-normal tracking-[-0.36px]",
            "border-[#3167DD] bg-[#3167DD] text-white",
            "hover:bg-[#2454c4] hover:border-[#2454c4]",
            "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]",
          )}
        >
          Try again
        </Button>
        <Button
          type="button"
          variant="defaultStable"
          size="auto"
          onClick={onClose}
          className="h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]"
        >
          Close
        </Button>
      </div>
    </div>
  );
}

function DoneBody({
  link,
  onCopy,
  onOpen,
  onClose,
  onRevoke,
}: {
  link: ShareLink;
  onCopy: () => void | Promise<void>;
  onOpen: () => void | Promise<void>;
  onClose: () => void;
  onRevoke: () => void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const expiresAtPretty = formatExpiresAt(link.expiresAt);
  const urlRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = urlRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [link.shareUrl]);

  const handleCopy = async () => {
    if (copied) return;
    await onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // The URL is rendered inside a textarea (not a div) so that:
  //   (1) `findByDisplayValue` keeps working in the test suite, and
  //   (2) users can select-all + Cmd-C on a long URL on browsers
  //       where the inline copy button isn't reachable.
  return (
    <div className="font-geist">
      {expiresAtPretty && (
        <p className="mb-3 text-center text-xs text-grey-50 dark:text-grey-dark-600">
          Expires {expiresAtPretty}.
        </p>
      )}

      <div
        className={cn(
          "mb-6 flex items-start gap-2 rounded-[8px] border p-3",
          "border-grey-80 bg-white",
          "dark:border-[#494949] dark:bg-[#1f1f1f]",
        )}
      >
        <textarea
          ref={urlRef}
          readOnly
          value={link.shareUrl}
          onFocus={(e) => e.currentTarget.select()}
          rows={1}
          className={cn(
            "flex-1 resize-none overflow-hidden break-all bg-transparent font-mono text-xs outline-none",
            "text-grey-10 dark:text-grey-dark-800",
          )}
        />
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy link"}
          aria-label="Copy link"
          className={cn(
            "shrink-0 rounded-md border px-1.5 py-1 transition-colors",
            copied
              ? "border-success-90 bg-success-100 text-success-50 dark:border-success-50/60 dark:bg-success-50/10 dark:text-success-50"
              : cn(
                  "border-grey-80 bg-grey-90 text-grey-10 hover:bg-grey-80",
                  "dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#363636]",
                ),
          )}
        >
          {copied ? (
            <Check className="size-4" />
          ) : (
            <Icons.Copy className="size-4" />
          )}
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <Button
          type="button"
          variant="primary"
          size="auto"
          onClick={onOpen}
          className={cn(
            "h-[52px] w-full rounded-[6px] border text-base font-normal tracking-[-0.36px]",
            "border-[#3167DD] bg-[#3167DD] text-white",
            "hover:bg-[#2454c4] hover:border-[#2454c4]",
            "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]",
          )}
        >
          Open in browser
        </Button>
        <Button
          type="button"
          variant="defaultStable"
          size="auto"
          onClick={onClose}
          className="h-[52px] w-full rounded-[6px] text-base font-normal tracking-[-0.36px]"
        >
          Done
        </Button>
        <button
          type="button"
          onClick={onRevoke}
          className={cn(
            "mx-auto mt-1 flex items-center gap-1.5 text-xs font-medium transition-colors",
            "text-error-70 hover:text-error-60",
          )}
        >
          <Icons.Trash className="size-3.5" />
          Revoke share
        </button>
      </div>
    </div>
  );
}

/**
 * Convert an RFC 3339 timestamp into a human-friendly relative-time
 * string. Returns `null` if the timestamp is unparseable so the
 * caller can omit the "Expires …" line entirely instead of showing
 * "Expires Invalid Date".
 */
function formatExpiresAt(rfc3339: string): string | null {
  const ts = Date.parse(rfc3339);
  if (Number.isNaN(ts)) return null;
  const diffMs = ts - Date.now();
  if (diffMs <= 0) return "in the past";
  const hours = Math.round(diffMs / 36e5);
  if (hours < 1) return "in less than an hour";
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}
