// Modal that creates a public share link for a synced file or folder.
//
// Lifecycle:
//
//   `running`  — mint IPC in flight. For a FILE: progress bar + filename
//                (indeterminate sweep until real progress arrives). For a
//                FOLDER: a plain spinner — the mint is one metadata POST
//                with no encrypt/upload phases, so a bar would imply work
//                that isn't happening.
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
// `createFolderShare` has no progress channel at all.

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
import { isCloudOnlyRow } from "@/app/lib/utils/cloudOnly";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { Button, Icons } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/select/Select";
import { cn } from "@/lib/utils";
import {
  finderShareAtom,
  shareModalFileAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import {
  cancelFinderShare,
  confirmFinderShare,
  createFolderShare,
  createRemoteShare,
  createShare,
  revokeShare,
  type ShareChoice,
  type ShareLink,
  type ShareProgress,
  type ShareTtl,
  type ShareVisibility,
  generateSharePassword,
} from "@/app/lib/tauri/shares";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { formatBytes } from "@/app/lib/utils/formatBytes";

/**
 * How recently a file must have been touched for the chooser to caution that
 * it may still be arriving.
 *
 * Deliberately a hint, not a gate. "Modified seconds ago" is exactly as true
 * of a file the user just saved on purpose as of one mid-download, so this
 * only ever adds a line of text — the size above it is the signal that
 * actually distinguishes the two. A minute is long enough to cover a stalled
 * write and short enough not to nag the ordinary save-then-share flow.
 */
const RECENTLY_MODIFIED_SECS = 60;

type ModalState =
  // Both entry points start here: the user picks expiry and public-vs-password
  // before anything is minted. The Finder flow confirms via
  // `confirmFinderShare` (the backend holds the path), the in-app flow via
  // `createShare`.
  | { kind: "choosing" }
  // `progress` is undefined until the backend reports it; the bar stays
  // indeterminate in that case.
  | { kind: "running"; progress?: ShareProgress }
  // The link carries its own `password` when the share is protected — the
  // backend returns it exactly once, so the done view is the only place it can
  // ever be shown.
  | { kind: "done"; link: ShareLink }
  | { kind: "error"; message: string };

export default function ShareFileModal() {
  const [target, setTarget] = useAtom(shareModalFileAtom);
  // The entry being shared, or `null` for a Finder-initiated share (which has
  // no row — the backend holds the resolved path).
  const file = target?.file ?? null;
  // A share from the macOS Finder right-click opens the in-app chooser (see
  // `FinderShareListener`): the atom carries only the `choosing` state, and this
  // modal then owns the `confirmFinderShare` → running → done/error lifecycle,
  // symmetric with the file-driven `createShare` flow.
  const [finderShare, setFinderShare] = useAtom(finderShareAtom);
  // Seed `choosing` when a Finder request is already parked at mount (covers the
  // event that fires before this effect-driven component re-renders, and the
  // test harness that renders with the atom pre-seeded); otherwise the in-app
  // flow starts in `running`.
  // This component is mounted permanently by the pages layout, so `state`
  // outlives any single share. See `sessionKey` below for why that matters.
  const [state, setState] = useState<ModalState>({ kind: "choosing" });
  // Remembered so "Try again" after a failure re-mints with the same choice
  // instead of silently falling back to a default the user never picked.
  const lastChoiceRef = useRef<ShareChoice | null>(null);
  // Auto-copy fires once per `done` transition. Reopening the dialog
  // without closing must not double-copy a stale URL.
  const autoCopiedRef = useRef(false);

  // The Finder flow has no `FormattedUserFile`, so fall back to the name the
  // backend sent with the choosing event for the label shown in every state.
  const finderName = finderShare?.kind === "choosing" ? finderShare.name : "";
  // For a FOLDER show the drive-relative path, not the basename: it is the only
  // confirmation of WHICH entry is about to be published, and two folders with
  // the same name in different places would otherwise look identical here.
  const filename =
    (target?.file.isFolder ? target.relativePath : file?.actualFileName) ||
    file?.name ||
    finderName;
  const folderLabel = file?.label;

  // The Finder flow carries a freshly-stat'd size; the in-app flow already has
  // one on the listing row. Show whichever is available, so the confirmation
  // reads the same at both entry points — a share is the last moment either
  // one can be checked by eye, and Finder is merely where that bit us first
  // (a half-downloaded zip minted a truncated link on 2026-08-31).
  //
  // A folder reports no size in either flow: nothing is uploaded when a folder
  // share is minted, so a byte count next to it would describe nothing.
  const sourceSizeBytes = target?.file.isFolder
    ? null
    : finderShare?.kind === "choosing"
      ? finderShare.sizeBytes
      : (file?.size ?? null);
  // Finder-only: the mtime age comes from the backend's stat of the clicked
  // path, and the in-app listing carries no equivalent.
  const sourceModifiedSecsAgo =
    finderShare?.kind === "choosing" ? finderShare.modifiedSecsAgo : null;

  const close = useCallback(() => {
    // Release a still-parked Finder request (chooser open, or the user bailed).
    // Idempotent server-side: after a confirm mints it the id is already taken,
    // so closing from done/error is a harmless no-op.
    if (finderShare?.kind === "choosing") void cancelFinderShare(finderShare.id);
    setTarget(null);
    setFinderShare(null);
  }, [finderShare, setTarget, setFinderShare]);

  const startShare = useCallback(
    async (choice: ShareChoice) => {
    if (!target || !folderLabel) return;
    lastChoiceRef.current = choice;
    setState({ kind: "running" });
    autoCopiedRef.current = false;
    try {
      // The path was resolved by whichever surface opened the modal — see
      // `ShareModalTarget`. Apply progress only while still running: channel
      // messages are delivered asynchronously, so a trailing `finalizing`
      // update can land after the IPC promise resolves and must not clobber
      // the `done`/`error` state we transition to below.
      const onProgress = (progress: ShareProgress) =>
        setState((prev) =>
          prev.kind === "running" ? { kind: "running", progress } : prev,
        );
      // A folder mints a live browsable link (one metadata POST, no upload,
      // no progress channel); the file command rejects a directory outright,
      // so the two are not interchangeable. A cloud-only file (remote-drive
      // row, cloud search hit, or a pending not-yet-downloaded file — the
      // shared isCloudOnlyRow discriminant) shares console-style: Rust
      // downloads + decrypts it to a temp copy and runs the same
      // re-encrypt-under-a-fresh-key pipeline.
      const link = target.file.isFolder
        ? await createFolderShare(folderLabel, target.relativePath, choice)
        : isCloudOnlyRow(target.file) && target.file.fileId
          ? await createRemoteShare(
              folderLabel,
              target.relativePath,
              target.file.fileId,
              choice,
              onProgress,
            )
          : await createShare(folderLabel, target.relativePath, choice, onProgress);
      setState({ kind: "done", link });
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
    }
    },
    [target, folderLabel],
  );

  // Confirm a Finder share once the user picks visibility in the chooser: mint
  // via `confirmFinderShare` (backend holds the resolved path — we send only the
  // id + choice), streaming progress into `running`, then land on `done`/`error`.
  const confirmFinder = useCallback(
    async (choice: ShareChoice) => {
      if (finderShare?.kind !== "choosing") return;
      const { id } = finderShare;
      lastChoiceRef.current = choice;
      setState({ kind: "running" });
      autoCopiedRef.current = false;
      try {
        const created = await confirmFinderShare(id, choice, (progress) =>
          setState((prev) =>
            prev.kind === "running" ? { kind: "running", progress } : prev,
          ),
        );
        setState({ kind: "done", link: created });
      } catch (err) {
        setState({ kind: "error", message: errorMessage(err) });
      }
    },
    [finderShare],
  );

  // One confirm handler for both entry points — the chooser does not care which
  // opened it, and routing here keeps the two flows from drifting apart.
  const onConfirmChoice = useCallback(
    (choice: ShareChoice) => {
      if (finderShare?.kind === "choosing") void confirmFinder(choice);
      else void startShare(choice);
    },
    [finderShare, confirmFinder, startShare],
  );

  // Re-run the last confirmed choice after a failure. Finder requests are
  // single-use server-side (the parked path is consumed on confirm), so only
  // the in-app flow can retry.
  const onRetry = useCallback(() => {
    const choice = lastChoiceRef.current;
    if (file && choice) void startShare(choice);
  }, [file, startShare]);

  // Identity of the share session currently open — `null` while closed.
  //
  // A STRING, not the file object: the atom may hand back a fresh object for
  // the same file on re-render, which would restart the session mid-upload.
  const sessionKey =
    finderShare?.kind === "choosing"
      ? `finder:${finderShare.id}`
      : target
        ? `file:${target.file.label}:${target.relativePath}`
        : null;

  // Reset on every session transition, close included.
  //
  // The modal never unmounts, so without this a finished share's `done` state
  // survives into the next one and the user is shown the PREVIOUS file's link.
  // Resetting on close (`sessionKey → null`) rather than only on open is what
  // makes re-sharing the same file twice work — the null in between changes
  // the key. It also covers a Finder request arriving while the modal is still
  // open on a previous result.
  //
  // Deliberately not driven off `close()`: any caller that clears the atoms
  // directly (`FinderShareListener`, a future surface) would bypass it, and
  // the failure mode is showing someone the wrong share link.
  useEffect(() => {
    setState({ kind: "choosing" });
    autoCopiedRef.current = false;
    lastChoiceRef.current = null;
  }, [sessionKey]);

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

  if (!file && !finderShare) return null;

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
      {state.kind === "choosing" && (
        <ChoosingBody
          filename={filename}
          isFolder={target?.file.isFolder ?? false}
          sizeBytes={sourceSizeBytes}
          modifiedSecsAgo={sourceModifiedSecsAgo}
          onConfirm={onConfirmChoice}
          onCancel={close}
        />
      )}

      {state.kind === "running" &&
        (target?.file.isFolder ? (
          <MintingBody filename={filename} onCancel={close} />
        ) : (
          <RunningBody
            filename={filename}
            progress={state.progress}
            onCancel={close}
          />
        ))}

      {state.kind === "done" && (
        <DoneBody
          link={state.link}
          password={state.link.password}
          onCopy={onCopy}
          onOpen={onOpenInBrowser}
          onClose={close}
          onRevoke={onRevoke}
        />
      )}

      {state.kind === "error" && (
        <ErrorBody
          message={state.message}
          filename={filename}
          // A Finder request is consumed by its confirm, so only the in-app
          // flow can re-mint.
          onRetry={file ? onRetry : undefined}
          onClose={close}
        />
      )}
    </FramedDialog>
  );
}

/** Expiry choices offered in the chooser, in the order they are shown. */
const TTL_OPTIONS: ReadonlyArray<{ label: string; value: ShareTtl }> = [
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "Until I revoke it", value: "never" },
];

/**
 * Minimum password length. Mirrors `SHARE_PASSWORD_MIN_LEN` in hcfs-client —
 * this copy only drives the inline hint and the disabled state, so a drift
 * degrades to a worse message, never to a weak password being accepted: Rust
 * re-validates at the IPC boundary and rejects.
 */
const PASSWORD_MIN_LEN = 8;

/**
 * The pre-mint picker, shared by the in-app and Finder entry points. The user
 * chooses how long the link lives and whether it needs a password; the parent
 * then runs the mint. Reuses the shared `SegmentedControl` and `Button` so it
 * reads as first-class app UI (matches the done/error bodies).
 */
function ChoosingBody({
  filename,
  isFolder,
  sizeBytes,
  modifiedSecsAgo,
  onConfirm,
  onCancel,
}: {
  filename: string;
  isFolder: boolean;
  /** Source size, when known. `null` renders nothing rather than "0 B". */
  sizeBytes: number | null;
  /** Seconds since last modification, when known. */
  modifiedSecsAgo: number | null;
  onConfirm: (choice: ShareChoice) => void;
  onCancel: () => void;
}) {
  const [visibility, setVisibility] = useState<ShareVisibility>("public");
  const [ttl, setTtl] = useState<ShareTtl>("24h");
  // Pre-filled with a generated password the first time the user switches to
  // "Password protected", so the common path is strong-by-default and the user
  // can still overwrite it. Empty until then, so we never generate one for a
  // share that stays public.
  const [password, setPassword] = useState("");

  const onVisibilityChange = (next: ShareVisibility) => {
    setVisibility(next);
    // Fetch a generated default the first time the user opts into a password.
    // If the backend call fails the field simply stays empty and the user
    // types their own — or leaves it blank, in which case the mint generates
    // one server-side anyway.
    if (next === "private" && !password) {
      void generateSharePassword()
        .then(setPassword)
        .catch(() => undefined);
    }
  };

  const passwordTooShort =
    visibility === "private" && password.length < PASSWORD_MIN_LEN;

  return (
    <div className="font-geist">
      <div className="mb-6 flex flex-col gap-1.5">
        <p className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">
          General access
        </p>
        <SegmentedControl<ShareVisibility>
          ariaLabel="Share access"
          fullWidth
          showActiveIndicator={false}
          value={visibility}
          onChange={onVisibilityChange}
          options={[
            { label: "Anyone with the link", value: "public" },
            { label: "Password protected", value: "private" },
          ]}
        />
        <p className="text-xs text-grey-50 dark:text-grey-dark-600">
          {visibility === "public"
            ? "Anyone with the link can view and download this file."
            : "The link can't be opened without this password. Send it separately — it can't be recovered or changed later."}
        </p>

        {visibility === "private" && (
          <div className="mt-2 flex flex-col gap-1">
            <label
              htmlFor="share-password"
              className="text-xs font-medium text-grey-30 dark:text-grey-dark-700"
            >
              Password
            </label>
            <Input
              id="share-password"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-sm"
            />
            {passwordTooShort && (
              <p className="text-xs text-red-500">
                Use at least {PASSWORD_MIN_LEN} characters.
              </p>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-col gap-1">
          {/* The Radix trigger is named via `ariaLabel` (no labelable element
              to point `htmlFor` at), so this is a purely visual caption. */}
          <span className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">
            Link expires
          </span>
          <Select
            ariaLabel="Link expires"
            value={ttl}
            onValueChange={(value) => setTtl(value as ShareTtl)}
            options={TTL_OPTIONS.map(({ label, value }) => ({ label, value }))}
          />
        </div>

        <p
          className="mt-3 break-all text-sm text-grey-20 dark:text-grey-dark-800"
          title={filename}
        >
          {filename}
          {sizeBytes !== null && (
            <span className="ml-2 whitespace-nowrap text-grey-40 dark:text-grey-dark-600">
              {formatBytes(sizeBytes)}
            </span>
          )}
        </p>

        {modifiedSecsAgo !== null &&
          modifiedSecsAgo < RECENTLY_MODIFIED_SECS && (
            <p className="mt-1 text-xs text-grey-40 dark:text-grey-dark-600">
              Modified moments ago — if it is still downloading, wait for it to
              finish before sharing.
            </p>
          )}

        {isFolder && <FolderShareNotice />}
      </div>

      <div className="flex flex-col gap-3">
        <Button
          type="button"
          variant="primary"
          size="auto"
          disabled={passwordTooShort}
          onClick={() =>
            onConfirm({
              ttl,
              visibility,
              // Only send a password on the private branch — Rust drops it on
              // the public one anyway, but not sending it keeps the intent
              // unambiguous at the boundary.
              password: visibility === "private" ? password : undefined,
            })
          }
          className={cn(
            "h-[52px] w-full rounded-[6px] border text-base font-normal tracking-[-0.36px]",
            "border-[#3167DD] bg-[#3167DD] text-white",
            "hover:bg-[#2454c4] hover:border-[#2454c4]",
            "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]",
          )}
        >
          Create share link
        </Button>
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
    </div>
  );
}

/**
 * What the user is agreeing to when they share a folder: a LIVE link. The
 * wording is the important part — recipients browse the folder's current
 * contents, so files added later ARE visible through the link (mirrors the
 * console's notice; the sender must not believe the link is frozen).
 */
function FolderShareNotice() {
  return (
    <p className="mt-3 text-xs text-grey-50 dark:text-grey-dark-600">
      Recipients can browse the folder and download files; the link always
      shows the current contents.
    </p>
  );
}

/**
 * Wait state for a folder mint: one metadata POST with no encrypt/upload
 * phases (console `MintingBody` parity), so a plain spinner — a progress
 * bar here would imply work that isn't happening.
 */
function MintingBody({
  filename,
  onCancel,
}: {
  filename: string;
  onCancel: () => void;
}) {
  return (
    <div className="font-geist">
      <div className="mb-6 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-grey-20 dark:text-grey-dark-800">
          <Loader2 className="size-4 animate-spin" />
          <span>Creating share link…</span>
        </div>
        <p
          className="break-all text-sm text-grey-20 dark:text-grey-dark-800"
          title={filename}
        >
          {filename}
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
          className="break-all text-sm text-grey-20 dark:text-grey-dark-800"
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
  filename,
  onRetry,
  onClose,
}: {
  message: string;
  // Shown when known (Finder share sends it on `finder:share-failed`; the in-app
  // flow has the file) so the user sees which file failed, not just the error.
  filename?: string;
  // Undefined for a Finder-minted share — there is no in-app retry path, so the
  // "Try again" button is omitted rather than shown as a dead control.
  onRetry?: () => void;
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
          {filename && (
            <p
              className="mt-1 break-all text-sm text-grey-20 dark:text-grey-dark-800"
              title={filename}
            >
              {filename}
            </p>
          )}
          <p className="mt-1 break-words text-xs text-grey-50 dark:text-grey-dark-600">
            {message}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {onRetry && (
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
        )}
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
      {/* State the lifetime either way: silently omitting the line for a
          never-expiring link reads as "we forgot to say", not as "no expiry". */}
      <p className="mb-3 text-center text-xs text-grey-50 dark:text-grey-dark-600">
        {link.expiresAt === null
          ? "This link stays active until you revoke it."
          : expiresAtPretty
            ? `Expires ${expiresAtPretty}.`
            : null}
      </p>

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
function formatExpiresAt(rfc3339: string | null): string | null {
  // A never-expiring link has no countdown to render; the caller drops the
  // whole "Expires …" line rather than printing a placeholder.
  if (rfc3339 === null) return null;
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
