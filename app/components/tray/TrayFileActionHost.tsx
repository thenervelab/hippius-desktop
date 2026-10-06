"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useRouter } from "next/navigation";
import { useAtomValue, useSetAtom } from "jotai";
import { toast } from "sonner";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import {
  parseTrayFileActionRequest,
  trayDriveLocation,
  TRAY_FILE_ACTION_EVENT,
  type TrayFileActionRequest,
} from "@/app/lib/tray/trayRowActions";
import { driveFolderRoute } from "@/app/lib/routes";
import { downloadFile } from "@/app/lib/utils/downloadFile";
import {
  offersShareAction,
  offersWriteAction,
  shareTargetFor,
} from "@/app/lib/utils/folderShareGating";
import {
  canRenameFile,
  RENAME_DISABLED_TOOLTIP,
} from "@/app/lib/utils/renameGating";
import {
  shareFeatureEnabledAtom,
  shareModalFileAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import { renameModalFileAtom } from "@/app/lib/global-atoms/renameAtoms";
import {
  useMemberDriveLabels,
  useWritableMemberDriveLabels,
} from "@/app/lib/hooks/useSharedDriveRoles";
import { FileSelectionProvider } from "@/app/contexts/FileSelectionContext";
import { UnifiedMediaDialog } from "@/app/components/page-sections/drive/file-preview";
import DeleteFileConfirmDialog from "@/app/components/page-sections/drive/DeleteFileConfirmDialog";

/** Said when a file in somebody else's drive cannot be renamed by this account. */
export const TRAY_RENAME_NOT_ALLOWED =
  "You can view this drive but not change it, so this file can't be renamed.";

/**
 * Runs the tray popover's row actions that need the main window: the popover
 * is a separate, provider-free webview, so it reveals this window and sends
 * `{ action, file }` through {@link TRAY_FILE_ACTION_EVENT}. Mounted once in
 * the protected layout.
 *
 * Each action goes to the same place the Drive's row menu sends it: the
 * global Share and Rename dialogs (`shareModalFileAtom`,
 * `renameModalFileAtom`), `downloadFile`, the one preview dialog
 * (`UnifiedMediaDialog`, mounted here like the sidebar search mounts it),
 * the Drive page at the file (`driveFolderRoute`), and the Drive's delete
 * behind a confirm. The Drive's role gates (`offersWriteAction`,
 * `canRenameFile`) are applied here again, because the popover cannot read
 * shared-drive roles; a refusal is a toast, never a silent no-op.
 */
export default function TrayFileActionHost() {
  const router = useRouter();
  const { polkadotAddress } = useWalletAuth();
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);
  const setShareModalFile = useSetAtom(shareModalFileAtom);
  const setRenameModalFile = useSetAtom(renameModalFileAtom);
  const memberDriveLabels = useMemberDriveLabels();
  const writableMemberDriveLabels = useWritableMemberDriveLabels();

  const [previewFile, setPreviewFile] = useState<FormattedUserFile | null>(
    null,
  );
  const [fileToDelete, setFileToDelete] = useState<FormattedUserFile | null>(
    null,
  );

  const handle = useCallback(
    ({ action, file }: TrayFileActionRequest) => {
      switch (action) {
        case "show-in-drive": {
          const at = trayDriveLocation(file);
          if (!at) return;
          router.push(
            driveFolderRoute(at.label, at.remote, at.subfolder, at.fileName),
          );
          return;
        }
        case "preview":
          setPreviewFile(file);
          return;
        case "download":
          void downloadFile(file, polkadotAddress ?? "");
          return;
        case "share":
          if (!shareEnabled || !offersShareAction(file, memberDriveLabels)) {
            toast.error("Links can't be made for this file.");
            return;
          }
          setShareModalFile(shareTargetFor(file, ""));
          return;
        case "rename":
          if (
            !offersWriteAction(file, memberDriveLabels, writableMemberDriveLabels)
          ) {
            toast.error(TRAY_RENAME_NOT_ALLOWED);
            return;
          }
          if (!canRenameFile(file)) {
            toast.error(RENAME_DISABLED_TOOLTIP);
            return;
          }
          setRenameModalFile(file);
          return;
        case "delete":
          setFileToDelete(file);
          return;
      }
    },
    [
      router,
      polkadotAddress,
      shareEnabled,
      memberDriveLabels,
      writableMemberDriveLabels,
      setShareModalFile,
      setRenameModalFile,
    ],
  );

  // The listener is registered once; it reads the latest handler through a
  // ref so the role sets settling later never re-subscribe (an event sent
  // while re-subscribing would be lost).
  const handleRef = useRef(handle);
  handleRef.current = handle;
  useEffect(() => {
    const unlisten = listen(TRAY_FILE_ACTION_EVENT, (event) => {
      const request = parseTrayFileActionRequest(event.payload);
      if (request) handleRef.current(request);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const closePreview = useCallback(() => setPreviewFile(null), []);
  const closeDelete = useCallback(() => setFileToDelete(null), []);

  return (
    <>
      {previewFile && (
        // `FileViewerLayout` reads the file selection context; a scoped
        // provider keeps this viewer's selection apart from the Drive page's.
        <FileSelectionProvider>
          <UnifiedMediaDialog
            file={previewFile}
            allFiles={[previewFile]}
            onCloseClicked={closePreview}
            onNavigate={setPreviewFile}
            handleFileDownload={(file, address) =>
              void downloadFile(file, address)
            }
            onDelete={(file) => {
              setPreviewFile(null);
              setFileToDelete(file);
            }}
          />
        </FileSelectionProvider>
      )}
      <DeleteFileConfirmDialog file={fileToDelete} onClose={closeDelete} />
    </>
  );
}
