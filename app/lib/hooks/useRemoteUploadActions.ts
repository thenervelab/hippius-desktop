"use client";

import { useCallback, useState } from "react";
import { open as openSelection } from "@tauri-apps/plugin-dialog";
import { useSetAtom } from "jotai";
import { toast } from "sonner";

import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { isNotReady } from "@/app/lib/utils/dispatchTauriError";
import { insufficientCreditsDialogOpenAtom } from "@/app/components/page-sections/drive/atoms/query-atoms";
import {
  uploadFilesToRemoteFolder,
  uploadFolderToRemoteFolder,
} from "@/app/lib/tauri/remoteUpload";
import {
  REMOTE_UPLOAD_TOAST_ID,
  reportRemoteFolderUploadStarted,
  reportRemoteUploadOutcome,
  reportRemoteUploadOutcomeForFolder,
  reportRemoteUploadStarted,
} from "@/app/lib/remote-upload/reportOutcome";

/**
 * Uploading into a folder that is not synced on this computer.
 *
 * Extracted from the two toolbar buttons so the right-click menu can run
 * the SAME action rather than a second copy of it. The menu previously
 * offered neither, because the local upload handlers target a local sync
 * root and a browsed drive has none — so a remote folder's menu had only
 * New Folder in it.
 *
 * Kept as hooks rather than plain functions because both need the wallet
 * address, the insufficient-credits dialog and a busy flag, and a caller
 * that assembled those itself would be a third place for the plan-gate
 * handling to drift.
 */
interface RemoteUploadTarget {
  /** Drive label; `null` disables the action. */
  label: string | null;
  /** Folder-relative path inside the drive; absent for its root. */
  parentPath?: string;
  onUploaded?: () => void;
}

interface RemoteUploadAction {
  start: () => void;
  busy: boolean;
}

/** Pick files and upload them straight to the server. */
export function useRemoteFileUpload({
  label,
  parentPath,
  onUploaded,
}: RemoteUploadTarget): RemoteUploadAction {
  const { polkadotAddress } = useWalletAuth();
  const setInsufficient = useSetAtom(insufficientCreditsDialogOpenAtom);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    if (!polkadotAddress || !label || busy) return;

    const picked = await openSelection({ multiple: true, directory: false });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length === 0) return;

    setBusy(true);
    // A brief "it started" toast, then out of the way. The sync widget
    // shows each file moving, but it lives in the sidebar and is easy to
    // miss, so an upload could look like nothing had happened; a toast
    // that STAYS for the length of a large upload is the opposite
    // problem, covering the thing the user is trying to watch. Fixed id
    // so a second pick replaces the first rather than stacking.
    reportRemoteUploadStarted(paths.length);
    try {
      const failures = await uploadFilesToRemoteFolder(
        polkadotAddress,
        label,
        paths,
        parentPath,
      );
      reportRemoteUploadOutcome(paths.length, failures);
      const uploaded = paths.length - failures.length;
      if (uploaded > 0) onUploaded?.();
    } catch (err) {
      // The plan gate refuses before any encryption happens, and the way
      // out is a bigger plan — same dialog as every other storage refusal.
      if (isNotReady(err, "STORAGE_LIMIT_REACHED")) {
        setInsufficient("file-upload");
      } else {
        toast.error(err instanceof Error ? err.message : "Upload failed", {
          id: REMOTE_UPLOAD_TOAST_ID,
        });
      }
    } finally {
      setBusy(false);
    }
  }, [polkadotAddress, label, parentPath, busy, onUploaded, setInsufficient]);

  return { start: () => void run(), busy };
}

/** Pick one folder and upload its contents straight to the server. */
export function useRemoteFolderUpload({
  label,
  parentPath,
  onUploaded,
}: RemoteUploadTarget): RemoteUploadAction {
  const { polkadotAddress } = useWalletAuth();
  const setInsufficient = useSetAtom(insufficientCreditsDialogOpenAtom);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    if (!polkadotAddress || !label || busy) return;

    const picked = await openSelection({ multiple: false, directory: true });
    const folderPath = Array.isArray(picked) ? picked[0] : picked;
    if (!folderPath) return;

    setBusy(true);
    // The file count is not known until Rust has walked the tree, so the
    // start notice speaks of the folder rather than promising a number
    // that would be wrong.
    reportRemoteFolderUploadStarted();
    try {
      const failures = await uploadFolderToRemoteFolder(
        polkadotAddress,
        label,
        folderPath,
        parentPath,
      );
      reportRemoteUploadOutcomeForFolder(failures);
      onUploaded?.();
    } catch (err) {
      // The plan gate refuses before anything is read, and the way out is
      // a bigger plan — same dialog as every other storage refusal.
      if (isNotReady(err, "STORAGE_LIMIT_REACHED")) {
        setInsufficient("folder-upload");
      } else {
        toast.error(err instanceof Error ? err.message : "Upload failed");
      }
    } finally {
      setBusy(false);
    }
  }, [polkadotAddress, label, parentPath, busy, onUploaded, setInsufficient]);

  return { start: () => void run(), busy };
}
