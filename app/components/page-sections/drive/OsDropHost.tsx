"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { CloudUploadIcon, HardDrive } from "lucide-react";
import { toast } from "sonner";

import UploadFileDialog, {
  type NestedUploadTarget,
} from "@/app/components/page-sections/drive/UploadFileDialog";
import FolderUploadDialog from "@/app/components/page-sections/drive/FolderUploadDialog";
import { insufficientCreditsDialogOpenAtom } from "@/app/components/page-sections/drive/atoms/query-atoms";
import { NO_DRIVE_TO_UPLOAD_TO } from "@/app/components/tray/TrayUploadDialogHost";
import {
  currentOsDropTarget,
  onOsDropTargetRegistered,
  osDropsClaimed,
  planClassifiedDrop,
  refusalBeforeReading,
  type OsDropTarget,
} from "@/app/lib/drive/osDrop";
import { isInAppDragActive } from "@/app/lib/drive-move/inAppDrag";
import { hasConfiguredDrivesAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { useCreditCheck } from "@/app/lib/hooks/useCreditCheck";
import {
  uploadFolderPathToRemoteFolder,
  uploadPathsToRemoteFolder,
} from "@/app/lib/hooks/useRemoteUploadActions";
import { takeTrayDrop, TRAY_DROP_WAITING_EVENT } from "@/app/lib/tray/trayDrop";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { filterDroppedPaths } from "@/lib/utils/filterDroppedPaths";
import { cn } from "@/lib/utils";

type FileDialog = {
  paths: string[];
  defaultFolderLabel: string | null;
  nestedUpload?: NestedUploadTarget;
};

type FolderDialog = { path: string; defaultFolderLabel: string | null };

/**
 * Every file or folder dropped on the main window from the OS, on every
 * page. The view on screen says where its drops go (`useOsDropTarget`);
 * this decides what to do with them and opens the same upload the view's
 * Upload buttons open:
 *
 * - inside a drive synced here, the "Upload File" dialog for that drive or
 *   folder, and the drive's own folder dialog for a folder;
 * - inside a drive that is not synced here, straight to the server, as its
 *   Upload buttons do once something is picked;
 * - where no drive is on screen (Recent Files, the drive list, Shared
 *   Drives), the "Upload File" or "Upload Folder" dialog, which asks which
 *   drive.
 *
 * It listens through `getCurrentWebview().onDragDropEvent`, which hears
 * this window only: a plain `listen("tauri://drag-drop")` also hears drops
 * on the tray popover. Popover drops arrive through `trayDrop` instead.
 * Mounted once in the protected layout.
 */
export default function OsDropHost() {
  const [overlayName, setOverlayName] = useState<string | null>(null);
  const [fileDialog, setFileDialog] = useState<FileDialog | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialog | null>(null);

  const hasConfiguredDrives = useAtomValue(hasConfiguredDrivesAtom);
  const setInsufficient = useSetAtom(insufficientCreditsDialogOpenAtom);
  const { requireUploadRoom } = useCreditCheck();
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();

  const dispatch = useCallback(
    async (paths: string[], target: OsDropTarget) => {
      if (paths.length === 0) return;

      const refusal = refusalBeforeReading(target);
      if (refusal) {
        // The files are already dropped by the time anything can check,
        // so a refusal is said rather than left as nothing happening.
        toast.error(refusal);
        return;
      }
      const destination = target.destination!;
      if (destination.kind === "choose" && !hasConfiguredDrives) {
        toast.warning(NO_DRIVE_TO_UPLOAD_TO);
        return;
      }

      const plan = planClassifiedDrop(await filterDroppedPaths(paths));
      if (plan.action === "refuse") {
        toast.error(plan.message);
        return;
      }
      if (plan.note) toast.info(plan.note);

      // No plan or no room: the same plan dialog as the Upload buttons,
      // never a picker or an upload.
      const reason = plan.action === "files" ? "file-upload" : "folder-upload";
      // The drive it lands in, so a drive shared with this account is judged
      // on its owner's room rather than this account's plan.
      const driveLabel = destination.kind === "choose" ? null : destination.label;
      if (!(await requireUploadRoom(reason, Boolean(target.storageBlocked), driveLabel))) return;

      const uploaded = () => {
        target.onUploaded?.();
        void notifyFilesMutated(queryClient, polkadotAddress);
      };

      if (destination.kind === "remote") {
        if (!polkadotAddress) return;
        const common = {
          account: polkadotAddress,
          label: destination.label,
          parentPath: destination.parentPath,
          onUploaded: uploaded,
        };
        if (plan.action === "files") {
          await uploadPathsToRemoteFolder({
            ...common,
            paths: plan.files,
            onStorageFull: () => setInsufficient("file-upload"),
          });
        } else {
          await uploadFolderPathToRemoteFolder({
            ...common,
            folderPath: plan.folder,
            onStorageFull: () => setInsufficient("folder-upload"),
          });
        }
        return;
      }

      const label = destination.kind === "local" ? destination.label : null;
      if (plan.action === "folder") {
        // A drive's own folder dialog knows where in the drive it is.
        if (target.openFolder) target.openFolder(plan.folder);
        else setFolderDialog({ path: plan.folder, defaultFolderLabel: label });
        return;
      }

      const folder = destination.kind === "local" ? destination.folder : undefined;
      setFileDialog({
        paths: plan.files,
        defaultFolderLabel: label,
        nestedUpload: folder
          ? {
              folderName: folder.name,
              subfolder: folder.subfolder,
              syncBasePath: folder.syncBasePath,
              onSuccess: target.onUploaded,
              driveLabel: label,
            }
          : undefined,
      });
    },
    [hasConfiguredDrives, requireUploadRoom, queryClient, polkadotAddress, setInsufficient],
  );

  // Read through a ref so the listener is registered once: re-subscribing
  // on every change would drop a drop that lands in between.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = fileDialog !== null || folderDialog !== null;

  const handleDrop = useCallback((paths: string[]) => {
    // A row dragged inside the app is a move, never an upload.
    if (isInAppDragActive()) return;
    // An open dialog with its own drop area takes it.
    if (osDropsClaimed() || dialogOpenRef.current) return;
    const target = currentOsDropTarget();
    if (!target) return;
    void dispatchRef.current(paths, target).catch((err) => {
      console.error("[OsDrop] drop failed:", err);
      toast.error("Couldn't start the upload. Try again.");
    });
  }, []);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    const hide = () => setOverlayName(null);

    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const un = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter") {
            const target = currentOsDropTarget();
            // The overlay shows only where a drop will be taken.
            const shows =
              target !== null &&
              !isInAppDragActive() &&
              !osDropsClaimed() &&
              !dialogOpenRef.current &&
              refusalBeforeReading(target) === null;
            setOverlayName(shows ? target.name : null);
          } else if (payload.type === "leave") {
            hide();
          } else if (payload.type === "drop") {
            hide();
            handleDrop(payload.paths ?? []);
          }
        });
        if (live) unlisten = un;
        else un();
      } catch (err) {
        console.error("[OsDrop] could not listen for dropped files:", err);
      }
    })();

    // A drag that leaves through a window blur sends no leave.
    window.addEventListener("blur", hide);
    return () => {
      live = false;
      unlisten?.();
      window.removeEventListener("blur", hide);
    };
  }, [handleDrop]);

  // Files dropped on the tray popover: `TrayNavigationListener` sends the
  // window to the Drive page and parks them; they are taken as soon as a
  // view that takes drops is on screen.
  useEffect(() => {
    const takeParked = () => {
      const target = currentOsDropTarget();
      if (!target) return;
      const paths = takeTrayDrop();
      if (!paths) return;
      void dispatchRef.current(paths, target).catch((err) => {
        console.error("[OsDrop] tray drop failed:", err);
      });
    };
    window.addEventListener(TRAY_DROP_WAITING_EVENT, takeParked);
    const offRegistered = onOsDropTargetRegistered(() => queueMicrotask(takeParked));
    takeParked();
    return () => {
      window.removeEventListener(TRAY_DROP_WAITING_EVENT, takeParked);
      offRegistered();
    };
  }, []);

  return (
    <>
      {overlayName !== null && (
        <div
          data-testid="os-drop-overlay"
          className={cn(
            "fixed inset-0 z-[60] pointer-events-none flex flex-col items-center justify-center",
            "bg-grey-light-300/50 dark:bg-[#000]/40",
            "border-2 border-dashed border-primary-50 rounded-lg",
          )}
        >
          <CloudUploadIcon className="size-10 text-[#3167dc] animate-slide-up motion-reduce:animate-none" />
          <div className="mt-2 font-medium text-center bg-primary-50 p-4 rounded-lg shadow-lg max-w-[calc(100vw-32px)]">
            <div className="text-white text-base">Drop files here to upload them to</div>
            <div className="flex items-center justify-center min-w-0">
              <HardDrive className="size-6 text-white mr-2 shrink-0" />
              <div className="text-white text-lg font-bold truncate">{overlayName}</div>
            </div>
          </div>
        </div>
      )}

      <UploadFileDialog
        open={fileDialog !== null}
        onClose={() => setFileDialog(null)}
        initialPaths={fileDialog?.paths ?? null}
        defaultFolderLabel={fileDialog?.defaultFolderLabel ?? null}
        nestedUpload={fileDialog?.nestedUpload}
      />
      <FolderUploadDialog
        open={folderDialog !== null}
        onClose={() => setFolderDialog(null)}
        defaultFolderLabel={folderDialog?.defaultFolderLabel ?? null}
        initialFolderPath={folderDialog?.path}
      />
    </>
  );
}
