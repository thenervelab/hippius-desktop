// Modal that creates a public share link for a synced file.
//
// Lifecycle:
//
//   `running`  — `hcfs_create_share` IPC in flight. Progress bar +
//                filename. The bar is indeterminate (a sweeping
//                placeholder) until real progress is available.
//   `done`     — link is ready. Read-only URL with an inline copy
//                button, auto-copied to clipboard, Open / Close /
//                Revoke actions.
//   `error`    — IPC failed. Inline error message + Try again / Close.
//
// Progress: `createShare` opens a `tauri::ipc::Channel<ShareProgress>`
// and forwards each backend update into the `running` state, so the bar
// is determinate (encrypting → uploading → finalizing) once the first
// update arrives. Before that — and for the single-shot path that reports
// phase edges only — `progress` is undefined and the bar falls back to
// the honest indeterminate sweep; we never fake a percentage.

"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAtom } from "jotai";
import { AlertCircle, Check } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { Button, Icons } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { cn } from "@/lib/utils";
import {
  finderShareLinkAtom,
  shareModalFileAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import {
  createShare,
  revokeShare,
  type ShareLink,
  type ShareProgress,
} from "@/app/lib/tauri/shares";
import { errorMessage } from "@/app/lib/utils/errorUtils";

type ModalState =
  // `progress` is undefined until the backend reports it; the bar stays
  // indeterminate in that case. Wiring the future `ShareProgress` channel
  // is just `setState({ kind: "running", progress })` from its callback.
  | { kind: "running"; progress?: ShareProgress }
  // `password` is set only for a Finder password-protected share — the
  // recipient needs it, so the done view shows it alongside the link.
  | { kind: "done"; link: ShareLink; password?: string }
  | { kind: "error"; message: string };

export default function ShareFileModal() {
  const [file, setFile] = useAtom(shareModalFileAtom);
  // A share minted from the macOS Finder right-click flow arrives already
  // created (see `FinderShareListener`); when set, the modal opens straight
  // into `done` rather than running the file-driven `createShare` lifecycle.
  const [finderLink, setFinderLink] = useAtom(finderShareLinkAtom);
  const [state, setState] = useState<ModalState>({ kind: "running" });
  // Auto-copy fires once per `done` transition. Reopening the dialog
  // without closing must not double-copy a stale URL.
  const autoCopiedRef = useRef(false);

  const filename = file?.actualFileName || file?.name || "";
  const folderLabel = file?.label;

  const close = useCallback(() => {
    setFile(null);
    setFinderLink(null);
  }, [setFile, setFinderLink]);

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
      // Apply progress only while still running: channel messages are
      // delivered asynchronously, so a trailing `finalizing` update can
      // land after the IPC promise resolves — it must not clobber the
      // `done`/`error` state we transition to below.
      const link = await createShare(folderLabel, relativePath, (progress) =>
        setState((prev) =>
          prev.kind === "running" ? { kind: "running", progress } : prev,
        ),
      );
      setState({ kind: "done", link });
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
    }
  }, [file, folderLabel]);

  // Kick off the share when the modal opens.
  useEffect(() => {
    if (file) startShare();
  }, [file, startShare]);

  // A Finder share is already minted, so open directly in `done`. Resetting
  // the auto-copy latch lets the copy-on-`done` effect run for this link.
  useEffect(() => {
    if (!finderLink) return;
    autoCopiedRef.current = false;
    setState({ kind: "done", link: finderLink, password: finderLink.password });
  }, [finderLink]);

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

  if (!file && !finderLink) return null;

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
        <RunningBody
          filename={filename}
          progress={state.progress}
          onCancel={close}
        />
      )}

      {state.kind === "done" && (
        <DoneBody
          link={state.link}
          password={state.password}
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
  progress,
  onCancel,
}: {
  filename: string;
  progress?: ShareProgress;
  onCancel: () => void;
}) {
  const pct = sharePercent(progress);

  return (
    <div className="font-geist">
      <div className="mb-6 flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-grey-20 dark:text-grey-dark-800">
            {runningLabel(progress)}
          </p>
          {pct !== null && (
            <span className="font-mono text-sm font-medium tabular-nums text-primary-50">
              {pct}%
            </span>
          )}
        </div>

        <ShareProgressBar pct={pct} />

        <p
          className="font-mono text-xs text-grey-50 dark:text-grey-dark-600 break-all"
          title={filename}
        >
          {filename}
        </p>
        <p className="text-xs text-grey-50 dark:text-grey-dark-600">
          Large files can take a while to encrypt and upload.
        </p>
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

/**
 * Share progress bar. Determinate when `pct` is a number (the future
 * backend-reported percentage); a sweeping indeterminate placeholder
 * otherwise. The two modes share the same track so wiring real progress
 * later needs no layout change.
 */
function ShareProgressBar({ pct }: { pct: number | null }) {
  return (
    <div
      className="relative h-2 w-full overflow-hidden rounded-full bg-blue-500/10"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(pct !== null ? { "aria-valuenow": pct } : {})}
    >
      {pct !== null ? (
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-600 transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      ) : (
        <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-blue-500 to-blue-600 animate-indeterminate-sweep" />
      )}
    </div>
  );
}

/** Percentage `0..100`, or `null` when progress is unknown (indeterminate). */
function sharePercent(progress?: ShareProgress): number | null {
  if (!progress || progress.bytesTotal <= 0) return null;
  return Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100));
}

/** Phase-aware status line; the indeterminate copy doubles as the v1 placeholder. */
function runningLabel(progress?: ShareProgress): string {
  switch (progress?.phase) {
    case "encrypting":
      return "Encrypting…";
    case "uploading":
      return "Uploading…";
    case "finalizing":
      return "Finishing up…";
    default:
      return "Encrypting and uploading…";
  }
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
  password,
  onCopy,
  onOpen,
  onClose,
  onRevoke,
}: {
  link: ShareLink;
  password?: string;
  onCopy: () => void | Promise<void>;
  onOpen: () => void | Promise<void>;
  onClose: () => void;
  onRevoke: () => void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [copiedPw, setCopiedPw] = useState(false);

  const handleCopyPassword = async () => {
    if (!password || copiedPw) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopiedPw(true);
      setTimeout(() => setCopiedPw(false), 2000);
    } catch (err) {
      toast.error(`Could not copy password: ${errorMessage(err)}`);
    }
  };
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

      {password && (
        <div className="mb-6">
          <p className="mb-1.5 text-xs font-medium text-grey-30 dark:text-grey-dark-700">
            Password
          </p>
          <div
            className={cn(
              "flex items-center gap-2 rounded-[8px] border p-3",
              "border-grey-80 bg-white",
              "dark:border-[#494949] dark:bg-[#1f1f1f]",
            )}
          >
            <input
              readOnly
              value={password}
              onFocus={(e) => e.currentTarget.select()}
              className={cn(
                "flex-1 bg-transparent font-mono text-xs outline-none",
                "text-grey-10 dark:text-grey-dark-800",
              )}
            />
            <button
              type="button"
              onClick={handleCopyPassword}
              title={copiedPw ? "Copied!" : "Copy password"}
              aria-label="Copy password"
              className={cn(
                "shrink-0 rounded-md border px-1.5 py-1 transition-colors",
                copiedPw
                  ? "border-success-90 bg-success-100 text-success-50 dark:border-success-50/60 dark:bg-success-50/10 dark:text-success-50"
                  : cn(
                      "border-grey-80 bg-grey-90 text-grey-10 hover:bg-grey-80",
                      "dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-white dark:hover:bg-[#363636]",
                    ),
              )}
            >
              {copiedPw ? (
                <Check className="size-4" />
              ) : (
                <Icons.Copy className="size-4" />
              )}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-grey-50 dark:text-grey-dark-600">
            Send this password separately — the link can&apos;t be opened
            without it.
          </p>
        </div>
      )}

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
