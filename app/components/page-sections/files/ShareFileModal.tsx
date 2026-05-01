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
//
// The visual layout mirrors the wallet dialogs (`SendBalanceDialog`,
// `ReceiveBalanceDialog`): centered `AbstractIconWrapper` header on
// desktop, mobile accent bar + close button on small screens, and
// stacked `CardButton`s for primary/secondary actions. Revoke is
// rendered as a small de-emphasized red link below the action stack
// because revoking is rare and shouldn't compete with Copy/Open.

"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAtom } from "jotai";
import { AlertCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import DialogContainer from "@/components/ui/DialogContainer";
import { AbstractIconWrapper, CardButton, Icons } from "@/components/ui";
import { shareModalFileAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { createShare, revokeShare, type ShareLink } from "@/app/lib/tauri/shares";
import { errorMessage } from "@/app/lib/utils/errorUtils";

type ModalState = { kind: "running" } | { kind: "done"; link: ShareLink } | { kind: "error"; message: string };

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
    <Dialog.Root open onOpenChange={(o) => (!o ? close() : undefined)}>
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[26.75rem] h-fit">
        <Dialog.Title className="sr-only">Share via link</Dialog.Title>
        {/* Mobile accent line */}
        <div className="h-4 bg-primary-50 md:hidden" />

        <div className="px-4">
          {/* Desktop Header */}
          <div className="hidden md:flex flex-col items-center justify-center pb-4 pt-4 gap-2">
            <div className="flex items-center mb-2 p-2">
              <AbstractIconWrapper className="size-8 sm:size-10">
                <Icons.Link className="absolute size-4 sm:size-6 text-primary-50" />
              </AbstractIconWrapper>
            </div>
            <span className="text-center text-2xl text-grey-10 font-medium">
              Share via link
            </span>
          </div>

          {/* Mobile Header */}
          <div className="flex py-4 items-center justify-between text-grey-10 md:hidden">
            <span className="text-lg font-medium">Share via link</span>
            <button onClick={close} aria-label="Close">
              <Icons.CloseCircle className="size-6" />
            </button>
          </div>

          {/* Body — one branch per state. */}
          {state.kind === "running" && (
            <div className="flex items-start gap-3 mb-2">
              <Icons.Loader className="size-5 animate-spin text-primary-60 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-grey-10">Encrypting and uploading…</p>
                <p className="text-xs text-grey-50 truncate mt-0.5" title={filename}>
                  {filename}
                </p>
              </div>
            </div>
          )}

          {state.kind === "done" && <DoneBody link={state.link} onCopy={onCopy} />}

          {state.kind === "error" && (
            <div className="flex items-start gap-2 text-error-70 mb-2">
              <AlertCircle className="size-4 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Couldn&apos;t create share link</p>
                <p className="text-xs text-grey-50 mt-1 break-words">{state.message}</p>
              </div>
            </div>
          )}

          {/* Footer — stacked `CardButton`s, full-width, mirroring the
              wallet dialogs. Revoke is rendered as a small de-emphasized
              red link below the stack so it doesn't compete with the
              Copy/Open primary actions. */}
          {state.kind === "running" && (
            <div className="flex flex-col gap-4 my-4">
              <CardButton className="w-full text-[1.125rem]" variant="secondary" onClick={close}>
                Cancel
              </CardButton>
            </div>
          )}

          {state.kind === "error" && (
            <div className="flex flex-col gap-4 my-4">
              <CardButton
                className="bg-primary-50 text-[1.125rem] hover:bg-primary-40 transition text-white w-full font-medium"
                variant="dialog"
                onClick={startShare}
              >
                Try again
              </CardButton>
              <CardButton className="w-full text-[1.125rem]" variant="secondary" onClick={close}>
                Close
              </CardButton>
            </div>
          )}

          {state.kind === "done" && (
            <div className="flex flex-col gap-4 my-4">
              <CardButton
                className="bg-primary-50 text-[1.125rem] hover:bg-primary-40 transition text-white w-full font-medium"
                variant="dialog"
                onClick={onOpenInBrowser}
              >
                Open in browser
              </CardButton>
              <CardButton className="w-full text-[1.125rem]" variant="secondary" onClick={close}>
                Done
              </CardButton>
              <button
                type="button"
                onClick={onRevoke}
                className="self-center flex items-center gap-1.5 text-xs font-medium text-error-70 hover:text-error-60 transition-colors"
              >
                <Icons.Trash className="size-3.5" />
                Revoke share
              </button>
            </div>
          )}
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}

// The URL card matches the bordered white address card in
// `ReceiveBalanceDialog`. We deliberately re-implement the
// "value + copy button" pattern inline instead of reusing `CopyText`:
// `CopyText` wraps the value in a `<div>`, which would (a) break the
// `findByDisplayValue` test seam in `ShareFileModal.test.tsx`, and
// (b) lose select-all-and-Cmd-C on a long URL. Don't "simplify" this
// to `CopyText` without porting the test queries first.
function DoneBody({
  link,
  onCopy,
}: {
  link: ShareLink;
  onCopy: () => void | Promise<void>;
}) {
  const expiresAtPretty = formatExpiresAt(link.expiresAt);
  // Auto-size the textarea to its content so the URL is never clipped
  // and no scrollbar ever appears. `useLayoutEffect` runs before paint,
  // avoiding a one-frame flash where the field is too short and shows
  // a scrollbar.
  const urlRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = urlRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [link.shareUrl]);
  return (
    <div>
      {expiresAtPretty && <p className="text-xs text-grey-50 mb-3">Expires {expiresAtPretty}.</p>}
      <div className="border border-grey-80 rounded-lg bg-white p-3 flex items-start gap-2">
        <textarea
          ref={urlRef}
          readOnly
          value={link.shareUrl}
          onFocus={(e) => e.currentTarget.select()}
          rows={1}
          className="flex-1 text-xs font-mono bg-transparent resize-none outline-none overflow-hidden break-all text-grey-10"
        />
        <button
          type="button"
          onClick={onCopy}
          title="Copy link"
          aria-label="Copy link"
          className="px-1.5 py-1 border border-grey-80 rounded bg-grey-90 hover:bg-grey-80 transition-colors shrink-0"
        >
          <Icons.Copy className="size-4 text-grey-10" />
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
