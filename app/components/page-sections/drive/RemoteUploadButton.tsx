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
    // No loading toast: the sync widget shows each file moving, and a
    // toast that sits there for the length of a large upload is noise
    // covering the thing the user is trying to watch. Only the OUTCOME
    // is worth a toast.
    try {
      const failures = await uploadFilesToRemoteFolder(
        polkadotAddress,
        label,
        paths,
        parentPath,
      );
      const uploaded = paths.length - failures.length;

      if (failures.length === 0) {
        // The widget already showed each row completing, so this is a
        // brief confirmation rather than the only signal.
        toast.success(uploaded === 1 ? "1 file uploaded" : `${uploaded} files uploaded`);
      } else if (uploaded === 0) {
        // Rust owns the sentence; it already explains why.
        toast.error(failures[0].error);
      } else {
        // Partial success is a real outcome here, so say both halves
        // rather than picking one and hiding the other.
        toast.warning(
          `${uploaded} uploaded, ${failures.length} failed: ${failures
            .map((f) => f.name)
            .join(", ")}`,
          { duration: 6000 },
        );
      }
      if (uploaded > 0) onUploaded?.();
    } catch (err) {
      // The plan gate refuses before any encryption happens, and the way
      // out is a bigger plan — same dialog as every other storage refusal.
      if (isNotReady(err, "STORAGE_LIMIT_REACHED")) {
        setInsufficient("file-upload");
      } else {
        toast.error(err instanceof Error ? err.message : "Upload failed");
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
