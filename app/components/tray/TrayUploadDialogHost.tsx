"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAtomValue } from "jotai";
import { toast } from "sonner";
import { hasConfiguredDrivesAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { uploadToIpfsAndSubmitToBlockcahinRequestStateAtom } from "@/app/components/page-sections/drive/atoms/query-atoms";
import { useCreditCheck } from "@/app/lib/hooks/useCreditCheck";
import { TRAY_OPEN_UPLOAD_EVENT } from "@/app/lib/tray/trayDrop";
import UploadFileDialog from "@/app/components/page-sections/drive/UploadFileDialog";

/** Said when there is no drive to upload into yet (the Upload button's words). */
export const NO_DRIVE_TO_UPLOAD_TO =
  "Set up a sync folder in Settings → Sync & Storage before uploading.";
/** Said when an upload from this dialog is still running. */
export const UPLOAD_ALREADY_RUNNING =
  "An upload is still running. Try again when it has finished.";

/**
 * Opens the "Upload File" dialog over whatever page the main window shows
 * when the tray popover's Upload tile is pressed (`TRAY_OPEN_UPLOAD_EVENT`).
 * It is the same dialog the Drive and Recent Files Upload buttons open
 * (`UploadFileDialog`), behind the same gates in the same order: room to
 * upload first (the plan dialog explains a refusal), then a drive to upload
 * into. The popover is a separate, provider-free webview, so it cannot open
 * a main-window dialog itself. Mounted once in the protected layout.
 */
export default function TrayUploadDialogHost() {
  const [open, setOpen] = useState(false);
  const hasConfiguredDrives = useAtomValue(hasConfiguredDrivesAtom);
  const uploading =
    useAtomValue(uploadToIpfsAndSubmitToBlockcahinRequestStateAtom) !== "idle";
  const { requireUploadRoom } = useCreditCheck();

  const request = useCallback(async () => {
    if (open) return;
    if (uploading) {
      toast.info(UPLOAD_ALREADY_RUNNING);
      return;
    }
    if (!(await requireUploadRoom("file-upload"))) return;
    if (!hasConfiguredDrives) {
      toast.warning(NO_DRIVE_TO_UPLOAD_TO);
      return;
    }
    setOpen(true);
  }, [open, uploading, requireUploadRoom, hasConfiguredDrives]);

  // Registered once; the latest gates are read through a ref so a change in
  // them never re-subscribes (an event sent meanwhile would be lost).
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    const unlisten = listen(TRAY_OPEN_UPLOAD_EVENT, () => {
      void requestRef.current();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const close = useCallback(() => setOpen(false), []);

  return <UploadFileDialog open={open} onClose={close} />;
}
