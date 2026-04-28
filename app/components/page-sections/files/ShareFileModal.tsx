// Modal that creates a public share link for a synced file.
//
// Lifecycle:
//
//   `running`  — `hcfs_create_share` IPC in flight. Spinner + filename.
//   `done`     — link is ready. Read-only URL, auto-copied to clipboard,
//                Copy / Open / Revoke buttons.
//   `error`    — IPC failed. Error message + Retry / Close.
//
// We picked a coarse three-state machine over per-byte progress because
// hcfs-client's share API does not expose a progress callback in v1
// (see `docs/plans/2026-04-28-file-sharing-design.md`). Faking smooth
// percentages would be a UX trap.

"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAtom } from "jotai";
import { Copy, ExternalLink, Loader2, Trash2, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import DialogContainer from "@/components/ui/DialogContainer";
import { shareModalFileAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { createShare, revokeShare, type ShareLink } from "@/app/lib/tauri/shares";
import { errorMessage } from "@/app/lib/utils/errorUtils";

type ModalState = { kind: "running" } | { kind: "done"; link: ShareLink } | { kind: "error"; message: string };

export default function ShareFileModal() {
  const [file, setFile] = useAtom(shareModalFileAtom);
  const [state, setState] = useState<ModalState>({ kind: "running" });
  // Guard so we only auto-copy once per `done` transition; opening the
  // dialog twice without closing wouldn't double-copy a stale URL.
  const autoCopiedRef = useRef(false);

  const filename = file?.actualFileName || file?.name || "";
  const folderLabel = file?.label;

  const close = useCallback(() => setFile(null), [setFile]);

  const startShare = useCallback(async () => {
    if (!file || !folderLabel) return;
    setState({ kind: "running" });
    autoCopiedRef.current = false;
    try {
      // `actualFileName` is already the relative path inside the sync
      // folder (e.g. `subdir/file.txt` for nested files); see
      // `FormattedUserFile` in `use-user-files`. Falling back to `name`
      // matches what `revealInFileManager` does in the context menu.
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

  // Auto-copy the URL once we've reached `done`. The textarea is still
  // shown so the user can verify and re-copy — auto-copy alone has been
  // a UX trap historically (focus loss, etc.).
  useEffect(() => {
    if (state.kind !== "done") return;
    if (autoCopiedRef.current) return;
    autoCopiedRef.current = true;
    navigator.clipboard
      .writeText(state.link.shareUrl)
      .then(() => toast.success("Link copied to clipboard"))
      .catch((err: unknown) => {
        // Auto-copy is a best-effort niceness; a clipboard rejection
        // (Safari focus rules etc.) shouldn't break the modal.
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
      toast.success("Share revoked");
      close();
    } catch (err) {
      toast.error(`Could not revoke share: ${errorMessage(err)}`);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => (!o ? close() : undefined)}>
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[32rem] h-fit">
        <Dialog.Title className="sr-only">Share via link</Dialog.Title>

        <div className="flex items-center justify-between px-5 py-4 border-b border-grey-80">
          <h2 className="text-base font-medium text-grey-10">Share via link</h2>
          <button onClick={close} aria-label="Close" className="text-grey-30 hover:text-grey-10">
            <X className="size-5" />
          </button>
        </div>

        <div className="px-5 py-4">
          {state.kind === "running" && (
            <div className="flex items-start gap-3">
              <Loader2 className="size-5 animate-spin text-grey-30 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-grey-10">Encrypting and uploading…</p>
                <p className="text-xs text-grey-30 truncate" title={filename}>
                  {filename}
                </p>
              </div>
            </div>
          )}

          {state.kind === "done" && <DoneBody link={state.link} filename={filename} />}

          {state.kind === "error" && (
            <div>
              <p className="text-sm font-medium text-error-50">Couldn&apos;t create share link</p>
              <p className="text-xs text-grey-30 mt-1 break-words">{state.message}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-grey-80 bg-grey-95">
          {state.kind === "running" && (
            <button onClick={close} className="px-3 py-1.5 text-xs font-medium text-grey-30 hover:text-grey-10">
              Cancel
            </button>
          )}
          {state.kind === "error" && (
            <>
              <button onClick={close} className="px-3 py-1.5 text-xs font-medium text-grey-30 hover:text-grey-10">
                Close
              </button>
              <button onClick={startShare} className="px-3 py-1.5 text-xs font-medium bg-primary-50 text-white rounded hover:bg-primary-60">
                Try again
              </button>
            </>
          )}
          {state.kind === "done" && (
            <>
              <button
                onClick={onRevoke}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-error-50 hover:text-error-60"
              >
                <Trash2 className="size-3.5" />
                Revoke
              </button>
              <button
                onClick={onOpenInBrowser}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-grey-30 hover:text-grey-10"
              >
                <ExternalLink className="size-3.5" />
                Open
              </button>
              <button
                onClick={onCopy}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-primary-50 text-white rounded hover:bg-primary-60"
              >
                <Copy className="size-3.5" />
                Copy link
              </button>
            </>
          )}
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}

function DoneBody({ link, filename }: { link: ShareLink; filename: string }) {
  // Render the URL in a read-only textarea so the user can verify and
  // copy — even if auto-copy succeeded. Plan note: auto-copy alone is
  // a UX trap.
  const expiresAtPretty = formatExpiresAt(link.expiresAt);
  return (
    <div>
      <p className="text-sm text-grey-10 mb-1">
        Anyone with this link can download <span className="font-medium">{filename || "this file"}</span>.
      </p>
      {expiresAtPretty && <p className="text-xs text-grey-30 mb-3">Expires {expiresAtPretty}.</p>}
      <textarea
        readOnly
        value={link.shareUrl}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full text-xs font-mono p-2 bg-grey-95 border border-grey-80 rounded resize-none break-all"
        rows={3}
      />
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
