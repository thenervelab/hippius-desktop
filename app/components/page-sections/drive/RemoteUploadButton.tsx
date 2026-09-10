"use client";

import React, { useState } from "react";
import { open as openSelection } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { isNotReady } from "@/app/lib/utils/dispatchTauriError";
import { useSetAtom } from "jotai";
import { insufficientCreditsDialogOpenAtom } from "./atoms/query-atoms";
import { uploadFilesToRemoteFolder } from "@/app/lib/tauri/remoteUpload";
import { UPLOAD_FILE_LABEL } from "./uploadActions";
import {
  REMOTE_UPLOAD_TOAST_ID,
  reportRemoteUploadOutcome,
  reportRemoteUploadStarted,
} from "@/app/lib/remote-upload/reportOutcome";

/**
 * Upload into a folder that is not synced on this computer.
 *
 * The normal upload flow drops files into a local sync folder and lets the
 * engine push them; a browsed remote folder has no such directory, so this
 * picks files and hands their paths to Rust, which encrypts and posts them
 * to the server itself.
 *
 * It is a separate control rather than a mode of `AddFileButton` because
 * the two share nothing but the label: no sync-folder picker, no drop
 * target, no progress channel, and a different destination.
 */
const RemoteUploadButton: React.FC<{
  label: string;
  parentPath?: string;
  onUploaded?: () => void;
  className?: string;
}> = ({ label, parentPath, onUploaded, className }) => {
  const { polkadotAddress } = useWalletAuth();
  const setInsufficient = useSetAtom(insufficientCreditsDialogOpenAtom);
  const [busy, setBusy] = useState(false);

  const pickAndUpload = async () => {
    if (!polkadotAddress || busy) return;

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
  };

  return (
    <Button
      variant="primary"
      size="auto"
      disabled={busy}
      onClick={() => void pickAndUpload()}
      className={cn(
        "h-[30px] gap-[10px] rounded-[6px] px-3 py-[10px] font-geist text-[14px] leading-[1.109] tracking-[-0.28px]",
        className,
      )}
    >
      {busy ? <Icons.Loader className="size-4 animate-spin" /> : `+ ${UPLOAD_FILE_LABEL}`}
    </Button>
  );
};

export default RemoteUploadButton;
