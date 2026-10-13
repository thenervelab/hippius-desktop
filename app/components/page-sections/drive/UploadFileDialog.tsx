import { FilePlus2 } from "lucide-react";

import UploadFilesFlow from "./upload-files-flow";
import PrivacyBadge from "@/components/ui/PrivacyBadge";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { UPLOAD_FILE_LABEL } from "./uploadActions";

export interface NestedUploadTarget {
  folderName: string;
  /** Path relative to the sync root, e.g. "Photos/2024". */
  subfolder?: string;
  /** Resolved sync-root absolute path for the active drive. */
  syncBasePath?: string;
  /** Fired after a successful upload so the parent can refresh listings. */
  onSuccess?: () => void;
}

/**
 * The "Upload File" dialog: the Private badge, the drop area and, at a
 * drive's root, the "Upload to folder" choice. The Drive and Recent Files
 * Upload buttons (`AddButton`) and the tray popover's Upload tile
 * (`TrayUploadDialogHost`) all open this one dialog, so a file is uploaded
 * the same way from either place. Opening it is the caller's job, with the
 * caller's gates (an upload allowance, a drive to upload to).
 */
export default function UploadFileDialog({
  open,
  onClose,
  initialFiles = null,
  initialPaths = null,
  defaultFolderLabel,
  nestedUpload,
}: {
  open: boolean;
  onClose: () => void;
  initialFiles?: FileList | null;
  initialPaths?: string[] | null;
  defaultFolderLabel?: string | null;
  /**
   * When set, files go into this subfolder of the open drive
   * (`UploadFilesFlow`'s folder mode) instead of a drive's root.
   */
  nestedUpload?: NestedUploadTarget;
}) {
  return (
    <FramedDialog
      open={open}
      onClose={onClose}
      title={UPLOAD_FILE_LABEL}
      icon={<FilePlus2 className="size-4 text-white" />}
      maxWidth="max-w-[653px]"
    >
      {/* Section label row, matches the Figma layout. */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="font-geist text-sm font-medium text-grey-60 dark:text-grey-dark-600 tracking-[-0.28px]">
          {UPLOAD_FILE_LABEL}
        </span>
        <PrivacyBadge variant="file" />
      </div>

      {nestedUpload ? (
        <UploadFilesFlow
          key="upload-file-nested"
          mode="folder"
          folderName={nestedUpload.folderName}
          subfolder={nestedUpload.subfolder}
          syncBasePath={nestedUpload.syncBasePath}
          initialFiles={initialFiles}
          initialPaths={initialPaths}
          onSuccess={() => {
            nestedUpload.onSuccess?.();
            onClose();
          }}
          onCancel={onClose}
        />
      ) : (
        <UploadFilesFlow
          key="upload-file"
          reset={onClose}
          initialFiles={initialFiles}
          initialPaths={initialPaths}
          defaultFolderLabel={defaultFolderLabel}
        />
      )}
    </FramedDialog>
  );
}
