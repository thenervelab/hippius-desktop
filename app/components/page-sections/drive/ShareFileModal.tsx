// Modal that creates a public share link for a synced file or folder.
//
// Lifecycle:
//
//   `running`  — mint IPC in flight. For a FILE or a folder COPY: progress
//                bar + filename (indeterminate sweep until real progress
//                arrives). For a FOLDER in a drive: a plain spinner — the
//                mint is one metadata POST with no encrypt/upload phases, so
//                a bar would imply work that isn't happening.
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
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
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
  insightsSheetAtom,
  shareInsightsEnabledAtom,
  shareModalFileAtom,
  type FinderShareState,
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
  getSharePreviewDefault,
  setSharePreview,
} from "@/app/lib/tauri/shares";
import { SettingsToggle } from "@/app/components/page-sections/settings/SettingsToggle";
import {
  getLinkSettings,
  getLinkSettingsDefault,
  setLinkSettings,
  switchChange,
  type LinkSettings,
  type LinkSettingsDefault,
  type OfferedSwitches,
} from "@/app/lib/tauri/shareInsights";
import LinkEngagementSwitches from "./LinkEngagementSwitches";
import { BILLING_ROUTE } from "@/app/lib/routes";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { isNotReady } from "@/app/lib/utils/dispatchTauriError";
import { insufficientCreditsDialogOpenAtom } from "@/app/components/page-sections/drive/atoms/query-atoms";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { isCaptureMedia } from "@/app/lib/utils/fileLinks";
import { sharesPageHref } from "@/app/lib/utils/sharesPageLink";
import { ExistingLinkBody, ExistingLinkSkeleton } from "./ExistingLinkBody";
import { useExistingLinks } from "./useExistingLinks";
import { useCopyExistingLink } from "./useCopyExistingLink";
import { captureLinkSource } from "./useCaptureInsightsItem";

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
  // `chatPreview`: a chat preview was asked for with the link, so the done
  // view offers to turn it off again.
  // `engagement`: the Insights / Comments / Reactions switches the link was
  // made with, and which this server takes, so the done view can change them.
  | { kind: "done"; link: ShareLink; chatPreview: boolean; engagement: Engagement | null }
  | { kind: "error"; message: string };

/**
 * A link's switches as chosen, which of them this server takes, and whether
 * the plan includes them (Rust's `switchesInPlan`).
 */
type Engagement = { offered: OfferedSwitches; value: LinkSettings; switchesInPlan: boolean | null };

/**
 * A password link's comments are sealed with a key the app never keeps (the
 * password is not stored), so they can only be read on the link's page.
 * The Comments switch is not offered for one, and this says why.
 */
export const PASSWORD_NO_COMMENTS = "Comments aren't offered for a password link, because they could only be read on the link's page.";

function withoutPasswordComments(offered: OfferedSwitches, isPassword: boolean): OfferedSwitches {
  return isPassword ? { ...offered, comments: false } : offered;
}

/** Under the finished link's switches when one asked for did not turn on. */
export const SWITCHES_NOT_ON = "Some of the settings you chose couldn't be turned on. Check them below and try again.";

/** What the chooser's switches were drawn from: carried into the done view. */
type SwitchSource = Pick<LinkSettingsDefault, "offered" | "switchesInPlan">;

/** The switches to carry into the done view, or `null` when none were shown. */
function engagementOf(choice: ShareChoice, source: SwitchSource | null): Engagement | null {
  if (!source || !choice.linkSettings) return null;
  return { offered: source.offered, value: choice.linkSettings, switchesInPlan: source.switchesInPlan };
}

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
  // Sharing is gated on the plan allowance like every other Drive action,
  // so an over-allowance account is refused here. Route that to the plan
  // dialog rather than showing the raw message inline: the way out is a
  // bigger plan, and the modal has nowhere to send them.
  const setInsufficient = useSetAtom(insufficientCreditsDialogOpenAtom);
  // Remembered so "Try again" after a failure re-mints with the same choice
  // instead of silently falling back to a default the user never picked.
  const lastChoiceRef = useRef<ShareChoice | null>(null);
  // Which switches that choice was made from, for the done view.
  const lastOfferedRef = useRef<SwitchSource | null>(null);
  // Auto-copy fires once per `done` transition. Reopening the dialog
  // without closing must not double-copy a stale URL.
  const autoCopiedRef = useRef(false);
  // The Finder request whose confirm is in flight, or `null`. A new
  // right-click replaces the session while that confirm still runs, so its
  // late result must be dropped (it would replace the new chooser) and the
  // superseded upload cancelled rather than left running unseen. The name
  // is kept for the toast that tells the user the old share stopped.
  const runningFinderRef = useRef<{ id: string; name: string } | null>(null);
  // An in-app share of something that already has a live link leads with
  // that link (`ExistingLinkBody`); "Create a new link" sets this and shows
  // the create form. Reset with every session.
  const [createAnother, setCreateAnother] = useState(false);
  const { linkFor, isLoadingFor } = useExistingLinks();
  const copyExistingLink = useCopyExistingLink();
  const existingLink = target ? linkFor(target.file, target.relativePath) : null;
  const existingLinkLoading = target ? isLoadingFor(target.file) : false;
  const insightsEnabled = useAtomValue(shareInsightsEnabledAtom);
  const openInsights = useSetAtom(insightsSheetAtom);

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
  // What Rust decides the "Show a preview in chats" switch from: the file's
  // own name (never the folder path shown above), its drive and whether it
  // is a folder.
  const previewSubject: PreviewSubject = {
    folderLabel: folderLabel ?? null,
    fileName: file ? file.actualFileName || file.name : finderName,
    isFolder: target?.file.isFolder ?? (finderShare?.kind === "choosing" && finderShare.isFolder),
  };

  // The Finder flow carries a freshly-stat'd size; the in-app flow already has
  // one on the listing row. Show whichever is available, so the confirmation
  // reads the same at both entry points — a share is the last moment either
  // one can be checked by eye, and Finder is merely where that bit us first
  // (a half-downloaded zip minted a truncated link on 2026-08-31).
  //
  // An in-drive folder reports no size: nothing is uploaded when its live link
  // is minted. A Finder folder outside every drive does carry one, because
  // its copy is uploaded.
  const sourceSizeBytes = target?.file.isFolder
    ? null
    : finderShare?.kind === "choosing"
      ? finderShare.sizeBytes
      : (file?.size ?? null);
  // Finder-only: the mtime age comes from the backend's stat of the clicked
  // path, and the in-app listing carries no equivalent.
  const sourceModifiedSecsAgo =
    finderShare?.kind === "choosing" ? finderShare.modifiedSecsAgo : null;
  // What kind of folder share this is, as Rust decided it; `null` for a
  // file. A live link (in a drive, from either entry point) gets the
  // live-link notice and the minting spinner; a copy gets neither (it is a
  // snapshot, and its upload has real progress); an unknown one promises
  // nothing either way.
  const folderKind = folderKindOf(target?.file.isFolder ?? false, finderShare);
  const isLiveFolder = folderKind === "live";
  // Finder folder copies only: Rust measures the folder after the chooser
  // opens, and may find the share would refuse it.
  const sizePending =
    finderShare?.kind === "choosing" && finderShare.sizePending;
  const refusal =
    finderShare?.kind === "choosing" ? (finderShare.refusal?.message ?? null) : null;

  const close = useCallback(() => {
    // Release a still-parked Finder request (chooser open, or the user bailed).
    // Idempotent server-side: after a confirm mints it the id is already taken,
    // so closing from done/error is a harmless no-op.
    if (finderShare?.kind === "choosing") void cancelFinderShare(finderShare.id);
    // Already cancelled just above; the session reset must not repeat it.
    runningFinderRef.current = null;
    setTarget(null);
    setFinderShare(null);
  }, [finderShare, setTarget, setFinderShare]);

  // The Insights upgrade prompt's Upgrade: the plans page, with this closed.
  const router = useRouter();
  const upgrade = useCallback(() => {
    close();
    router.push(BILLING_ROUTE);
  }, [close, router]);

  const startShare = useCallback(
    async (choice: ShareChoice, offered: SwitchSource | null) => {
    if (!target || !folderLabel) return;
    lastChoiceRef.current = choice;
    lastOfferedRef.current = offered;
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
      setState({
        kind: "done",
        link,
        chatPreview: choice.chatPreview === true,
        engagement: target.file.isFolder ? null : engagementOf(choice, offered),
      });
    } catch (err) {
      if (isNotReady(err, "STORAGE_LIMIT_REACHED")) {
        setTarget(null);
        setInsufficient("sharing");
        return;
      }
      setState({ kind: "error", message: errorMessage(err) });
    }
    },
    [target, folderLabel, setTarget, setInsufficient],
  );

  // Confirm a Finder share once the user picks visibility in the chooser: mint
  // via `confirmFinderShare` (backend holds the resolved path — we send only the
  // id + choice), streaming progress into `running`, then land on `done`/`error`.
  const confirmFinder = useCallback(
    async (choice: ShareChoice, offered: SwitchSource | null) => {
      if (finderShare?.kind !== "choosing") return;
      const { id, name } = finderShare;
      lastChoiceRef.current = choice;
      runningFinderRef.current = { id, name };
      setState({ kind: "running" });
      autoCopiedRef.current = false;
      // Another session took the modal over while this confirm ran.
      const superseded = () => runningFinderRef.current?.id !== id;
      try {
        const created = await confirmFinderShare(id, choice, (progress) => {
          if (superseded()) return;
          setState((prev) =>
            prev.kind === "running" ? { kind: "running", progress } : prev,
          );
        });
        if (superseded()) return;
        runningFinderRef.current = null;
        setState({
          kind: "done",
          link: created,
          chatPreview: choice.chatPreview === true,
          engagement: engagementOf(choice, offered),
        });
      } catch (err) {
        if (superseded()) return;
        runningFinderRef.current = null;
        if (isNotReady(err, "STORAGE_LIMIT_REACHED")) {
          setFinderShare(null);
          setInsufficient("sharing");
          return;
        }
        setState({ kind: "error", message: errorMessage(err) });
      }
    },
    [finderShare, setFinderShare, setInsufficient],
  );

  // One confirm handler for both entry points — the chooser does not care which
  // opened it, and routing here keeps the two flows from drifting apart.
  const onConfirmChoice = useCallback(
    (choice: ShareChoice, offered: SwitchSource | null) => {
      if (finderShare?.kind === "choosing") void confirmFinder(choice, offered);
      else void startShare(choice, offered);
    },
    [finderShare, confirmFinder, startShare],
  );

  // Re-run the last confirmed choice after a failure. Finder requests are
  // single-use server-side (the parked path is consumed on confirm), so only
  // the in-app flow can retry.
  const onRetry = useCallback(() => {
    const choice = lastChoiceRef.current;
    if (file && choice) void startShare(choice, lastOfferedRef.current);
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
    // A Finder confirm still running belongs to the session just replaced:
    // cancel it, and clearing the ref makes its late result a no-op. Its
    // modal is gone, so a toast is the only word the user gets that the
    // share stopped (a folder copy may have been uploading for minutes).
    const running = runningFinderRef.current;
    if (running !== null && sessionKey !== `finder:${running.id}`) {
      void cancelFinderShare(running.id);
      runningFinderRef.current = null;
      toast.error(`Sharing \u201c${running.name}\u201d was stopped to open the new share.`);
    }
    setState({ kind: "choosing" });
    setCreateAnother(false);
    autoCopiedRef.current = false;
    lastChoiceRef.current = null;
    lastOfferedRef.current = null;
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
      {state.kind === "choosing" && target && !createAnother && existingLinkLoading && (
        <ExistingLinkSkeleton />
      )}

      {state.kind === "choosing" && target && !createAnother && !existingLinkLoading && existingLink && (
        <ExistingLinkBody
          link={existingLink}
          filename={filename}
          onCopy={() => {
            // An unlock opens its own dialog, so this one steps aside.
            if (existingLink.state === "locked") close();
            copyExistingLink(existingLink, target);
          }}
          onManage={() => {
            close();
            router.push(sharesPageHref(existingLink.manageRowIds));
          }}
          onInsights={
            insightsEnabled &&
            existingLink.shareToken &&
            !target.file.isFolder &&
            isCaptureMedia(target.relativePath)
              ? () => {
                  close();
                  openInsights({
                    shareToken: existingLink.shareToken,
                    fileName: target.file.actualFileName || target.file.name,
                    file: target.file,
                    capture: captureLinkSource(target.file, target.relativePath),
                  });
                }
              : undefined
          }
          onCreateAnother={() => setCreateAnother(true)}
        />
      )}

      {state.kind === "choosing" &&
        (!target || createAnother || (!existingLinkLoading && !existingLink)) && (
        <ChoosingBody
          // A new session (another file, a new Finder click) starts the
          // chooser afresh, its preview switch included.
          key={sessionKey ?? "closed"}
          filename={filename}
          previewSubject={previewSubject}
          folderKind={folderKind}
          sizeBytes={sourceSizeBytes}
          sizePending={sizePending}
          refusal={refusal}
          modifiedSecsAgo={sourceModifiedSecsAgo}
          onConfirm={onConfirmChoice}
          onCancel={close}
          onUpgrade={upgrade}
        />
      )}

      {state.kind === "running" &&
        (isLiveFolder ? (
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
          chatPreview={state.chatPreview}
          engagement={state.engagement}
          onCopy={onCopy}
          onOpen={onOpenInBrowser}
          onClose={close}
          onUpgrade={upgrade}
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

/**
 * A folder share's kind: a live link to a folder in a drive, an uploaded
 * copy of a folder outside every drive, or unknown (Rust could not read the
 * drive roots, so the chooser promises neither).
 */
type FolderKind = "live" | "copy" | "unknown";

/**
 * The folder kind of the open share, `null` for a file. An in-app folder is
 * always in a drive; a Finder folder carries Rust's decision.
 */
function folderKindOf(
  inAppFolder: boolean,
  finderShare: FinderShareState | null,
): FolderKind | null {
  if (inAppFolder) return "live";
  if (finderShare?.kind !== "choosing" || !finderShare.isFolder) return null;
  if (finderShare.isFolderCopy === null) return "unknown";
  return finderShare.isFolderCopy ? "copy" : "live";
}

/** What the preview switch is decided from (see `getSharePreviewDefault`). */
interface PreviewSubject {
  folderLabel: string | null;
  fileName: string;
  isFolder: boolean;
}

/**
 * "Show a preview in chats": with it on, chat apps show a picture of the
 * file when its link is pasted, instead of a generic Hippius card. The
 * picture and the name are readable by the server, which the line under
 * the switch says.
 */
function ChatPreviewSwitch({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="mt-3 flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">
          Show a preview in chats
        </span>
        <SettingsToggle
          ariaLabel="Show a preview in chats"
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      </div>
      <p className="text-xs text-grey-50 dark:text-grey-dark-600">
        The preview picture and file name aren&apos;t encrypted.
      </p>
    </div>
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
  previewSubject,
  folderKind,
  sizeBytes,
  sizePending,
  refusal,
  modifiedSecsAgo,
  onConfirm,
  onCancel,
  onUpgrade,
}: {
  filename: string;
  previewSubject: PreviewSubject;
  /** The folder share's kind, or `null` for a file. */
  folderKind: FolderKind | null;
  /** Source size, when known. `null` renders nothing rather than "0 B". */
  sizeBytes: number | null;
  /** The size is still being measured (a Finder folder copy). */
  sizePending: boolean;
  /**
   * Rust's sentence for why this share would be refused, shown verbatim;
   * the confirm stays disabled, since it would fail with the same words.
   */
  refusal: string | null;
  /** Seconds since last modification, when known. */
  modifiedSecsAgo: number | null;
  onConfirm: (choice: ShareChoice, offered: SwitchSource | null) => void;
  onCancel: () => void;
  onUpgrade: () => void;
}) {
  const [visibility, setVisibility] = useState<ShareVisibility>("public");
  const [ttl, setTtl] = useState<ShareTtl>("24h");
  // Pre-filled with a generated password the first time the user switches to
  // "Password protected", so the common path is strong-by-default and the user
  // can still overwrite it. Empty until then, so we never generate one for a
  // share that stays public.
  const [password, setPassword] = useState("");
  // Whether the preview switch is shown, and where it stands. Rust decides
  // both (on for a capture when Settings says so); until it answers the
  // switch is hidden and off, so nothing is sent by a quick confirm.
  const [previewOffered, setPreviewOffered] = useState(false);
  const [chatPreview, setChatPreview] = useState(false);
  const { folderLabel: previewLabel, fileName: previewName, isFolder: previewIsFolder } = previewSubject;
  useEffect(() => {
    let alive = true;
    getSharePreviewDefault(previewLabel, previewName, previewIsFolder)
      .then((d) => {
        if (!alive || !d) return;
        setPreviewOffered(d.offered);
        setChatPreview(d.on);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [previewLabel, previewName, previewIsFolder]);
  // A password link never gets a preview: the switch is hidden and off.
  const previewShown = previewOffered && visibility === "public";
  // Insights, Comments and Reactions: which this server takes and where they
  // start (on for a capture when Settings says so), both from Rust. Hidden
  // until it answers, so a quick confirm sends nothing.
  const [offered, setOffered] = useState<OfferedSwitches | null>(null);
  // Rust's plan answer: `false` locks turning any switch on behind the
  // upgrade prompt; `null` (unread) locks nothing.
  const [switchesInPlan, setSwitchesInPlan] = useState<boolean | null>(null);
  const [engagement, setEngagement] = useState<LinkSettings>({
    insights: false,
    comments: false,
    reactions: false,
  });
  useEffect(() => {
    let alive = true;
    getLinkSettingsDefault(previewLabel, previewName, previewIsFolder)
      .then((d) => {
        if (!alive || !d) return;
        setOffered(d.offered);
        setEngagement(d.on);
        setSwitchesInPlan(d.switchesInPlan ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [previewLabel, previewName, previewIsFolder]);
  const switchesShown =
    offered !== null && (offered.insights || offered.comments || offered.reactions);

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
            ? `Anyone with the link can view and download this ${folderKind !== null ? "folder" : "file"}.`
            : "The link can't be opened without this password. Send it separately. It can't be recovered or changed later."}
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

        {previewShown && (
          <ChatPreviewSwitch checked={chatPreview} onChange={setChatPreview} />
        )}

        {switchesShown && (
          <>
            <LinkEngagementSwitches
              offered={withoutPasswordComments(offered, visibility === "private")}
              value={engagement}
              switchesInPlan={switchesInPlan}
              onChange={setEngagement}
              onUpgrade={onUpgrade}
            />
            {visibility === "private" && offered.comments && (
              <p className="mt-1.5 text-xs text-grey-50 dark:text-grey-dark-600">{PASSWORD_NO_COMMENTS}</p>
            )}
          </>
        )}

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
          {sizeBytes === null && sizePending && (
            <span className="ml-2 whitespace-nowrap text-grey-40 dark:text-grey-dark-600">
              Measuring…
            </span>
          )}
        </p>

        {refusal !== null && (
          <>
            <p role="alert" className="mt-2 text-xs text-red-500">
              {refusal}
            </p>
            {/* Confirm stays disabled, and this chooser never re-measures:
                the way back is a fresh click once the folder is fixed. */}
            <p className="mt-1 text-xs text-grey-40 dark:text-grey-dark-600">
              Once that is fixed, right-click the folder in Finder and choose
              Share with Hippius again.
            </p>
          </>
        )}

        {modifiedSecsAgo !== null &&
          modifiedSecsAgo < RECENTLY_MODIFIED_SECS && (
            <p className="mt-1 text-xs text-grey-40 dark:text-grey-dark-600">
              Modified moments ago — if it is still downloading, wait for it to
              finish before sharing.
            </p>
          )}

        {folderKind === "live" && <FolderShareNotice />}
        {folderKind === "copy" && <FolderCopyNotice />}
      </div>

      <div className="flex flex-col gap-3">
        <Button
          type="button"
          variant="primary"
          size="auto"
          disabled={passwordTooShort || refusal !== null}
          onClick={() =>
            onConfirm({
              ttl,
              visibility,
              // Only send a password on the private branch — Rust drops it on
              // the public one anyway, but not sending it keeps the intent
              // unambiguous at the boundary.
              password: visibility === "private" ? password : undefined,
              chatPreview: previewShown && chatPreview,
              linkSettings: switchesShown
                ? visibility === "private"
                  ? { ...engagement, comments: false }
                  : engagement
                : undefined,
            }, switchesShown ? { offered, switchesInPlan } : null)
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
 * What the user agrees to when they share a folder from outside their
 * drives: an uploaded COPY, frozen at share time and deleted with the link.
 * The opposite promise to `FolderShareNotice`, so the two never render
 * together.
 */
function FolderCopyNotice() {
  return (
    <p className="mt-3 text-xs text-grey-50 dark:text-grey-dark-600">
      Hippius uploads a copy of this folder for the link. Changes you make to
      the folder later won&apos;t reach it, and the copy is removed when the
      link expires or you revoke it.
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
  chatPreview,
  engagement,
  onCopy,
  onOpen,
  onClose,
  onUpgrade,
  onRevoke,
}: {
  link: ShareLink;
  password?: string;
  /** A chat preview was asked for with this link: offer to turn it off. */
  chatPreview: boolean;
  /** The link's switches, when the dialog showed them: they can be changed here. */
  engagement: Engagement | null;
  onCopy: () => void | Promise<void>;
  onOpen: () => void | Promise<void>;
  onClose: () => void;
  onUpgrade: () => void;
  onRevoke: () => void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [copiedPw, setCopiedPw] = useState(false);
  const [previewOn, setPreviewOn] = useState(chatPreview);
  const [previewSaving, setPreviewSaving] = useState(false);
  const [switches, setSwitches] = useState<LinkSettings | null>(engagement?.value ?? null);
  const [switchesSaving, setSwitchesSaving] = useState(false);
  const [switchesNote, setSwitchesNote] = useState<string | null>(null);
  const switchesTouched = useRef(false);

  // The switches asked for are sent just after the link is made, in the
  // background. Read them back (Rust answers once that send is done), so the
  // switches show what the link has, and say so when one did not turn on. A
  // change the user already made wins over this read.
  useEffect(() => {
    const asked = engagement?.value;
    if (!asked || !(asked.insights || asked.comments || asked.reactions)) return;
    let alive = true;
    getLinkSettings(link.shareToken)
      .then((real) => {
        if (!alive || switchesTouched.current) return;
        setSwitches(real.on);
        const missed = (["insights", "comments", "reactions"] as const).some(
          (key) => asked[key] && real.offered[key] && !real.on[key],
        );
        if (missed) setSwitchesNote(SWITCHES_NOT_ON);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // Once, for the link just made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link.shareToken]);

  // Shown as changed at once, put back if the server refuses. Only the
  // switch flipped is sent.
  const changeSwitches = async (next: LinkSettings) => {
    const before = switches;
    switchesTouched.current = true;
    setSwitchesNote(null);
    setSwitches(next);
    setSwitchesSaving(true);
    try {
      await setLinkSettings(link.shareToken, before ? switchChange(before, next) : next);
    } catch (err) {
      setSwitches(before);
      toast.error(errorMessage(err));
    } finally {
      setSwitchesSaving(false);
    }
  };

  // Off removes the preview from the server; on makes it again from the
  // file. Shown as changed at once, put back if Rust refuses.
  const changePreview = async (next: boolean) => {
    setPreviewOn(next);
    setPreviewSaving(true);
    try {
      await setSharePreview(link.shareToken, next);
    } catch (err) {
      setPreviewOn(!next);
      toast.error(errorMessage(err));
    } finally {
      setPreviewSaving(false);
    }
  };

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

      {chatPreview && !password && (
        <div className="-mt-3 mb-6">
          <ChatPreviewSwitch
            checked={previewOn}
            disabled={previewSaving}
            onChange={(next) => void changePreview(next)}
          />
        </div>
      )}

      {engagement && switches && (
        <div className="-mt-3 mb-6">
          <LinkEngagementSwitches
            offered={withoutPasswordComments(engagement.offered, Boolean(password))}
            value={switches}
            disabled={switchesSaving}
            switchesInPlan={engagement.switchesInPlan}
            onChange={(next) => void changeSwitches(next)}
            onUpgrade={onUpgrade}
          />
          {switchesNote && (
            <p role="status" className="mt-2 text-xs leading-[1.45] text-error-50 dark:text-error-70">
              {switchesNote}
            </p>
          )}
        </div>
      )}

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
            Send this password separately. The link can&apos;t be opened
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
