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
import { uploadFolderToRemoteFolder } from "@/app/lib/tauri/remoteUpload";
import {
  reportRemoteUploadOutcomeForFolder,
  reportRemoteFolderUploadStarted,
} from "@/app/lib/remote-upload/reportOutcome";
import {
  TOOLBAR_BUTTON_GAP,
  UPLOAD_FOLDER_BUTTON_LABEL,
  UPLOAD_FOLDER_HINT,
} from "./uploadActions";
import { ArrowUpToLine } from "@/components/ui/icons";

/**
 * Upload a whole folder into a Drive folder that is not synced here.
 *
 * The sibling of {@link RemoteUploadButton} for folders. A local drive
 * gets a folder by copying it into the sync root and letting the engine
 * push it; there is no such root here, so Rust walks the tree and posts
 * each file with the wire path that reproduces the structure — which is
 * why this is its own control rather than a mode of the local flow.
 *
 * The view already offered New Folder and Upload File, so a folder was the
 * one thing that could be created here but not brought in.
 */
const RemoteFolderUploadButton: React.FC<{
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
  };

  return (
    <Button
      variant="defaultStable"
      size="auto"
      disabled={busy}
      title={UPLOAD_FOLDER_HINT}
      onClick={() => void pickAndUpload()}
      className={cn(
        "h-[30px] rounded-[6px] px-3 py-[10px] font-geist text-[14px] leading-[1.109] tracking-[-0.28px]",
        TOOLBAR_BUTTON_GAP,
        className,
      )}
    >
      {busy ? (
        <Icons.Loader className="size-4 animate-spin" />
      ) : (
        <>
          <ArrowUpToLine className="size-4 shrink-0" />
          {UPLOAD_FOLDER_BUTTON_LABEL}
        </>
      )}
    </Button>
  );
};

export default RemoteFolderUploadButton;
