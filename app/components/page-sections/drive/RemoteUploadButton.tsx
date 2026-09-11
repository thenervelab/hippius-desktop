"use client";

import React from "react";
import { useRemoteFileUpload } from "@/app/lib/hooks/useRemoteUploadActions";

import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  TOOLBAR_BUTTON_GAP,
  UPLOAD_FILE_BUTTON_LABEL,
  UPLOAD_FILE_LABEL,
} from "./uploadActions";
import { ArrowUpToLine } from "@/components/ui/icons";

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
  // The action lives in a hook so the right-click menu runs exactly this,
  // rather than a second copy of the pick-upload-report sequence.
  const { start: pickAndUpload, busy } = useRemoteFileUpload({
    label,
    parentPath,
    onUploaded,
  });

  return (
    <Button
      variant="primary"
      size="auto"
      disabled={busy}
      title={UPLOAD_FILE_LABEL}
      onClick={pickAndUpload}
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
          {UPLOAD_FILE_BUTTON_LABEL}
        </>
      )}
    </Button>
  );
};

export default RemoteUploadButton;
