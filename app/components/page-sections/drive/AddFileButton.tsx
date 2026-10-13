import { Button } from "@/components/ui";
import { Loader2 } from "lucide-react";

import {
  useState,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from "react";

import UploadFileDialog, { type NestedUploadTarget } from "./UploadFileDialog";
import { uploadToIpfsAndSubmitToBlockcahinRequestStateAtom } from "@/app/components/page-sections/drive/atoms/query-atoms";
import { useAtomValue } from "jotai";

import { cn } from "@/lib/utils";
import { hasConfiguredDrivesAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { toast } from "sonner";
import { useCreditCheck } from "@/lib/hooks/useCreditCheck";
import {
  TOOLBAR_BUTTON_GAP,
  UPLOAD_FILE_BUTTON_LABEL,
  UPLOAD_FILE_LABEL,
} from "./uploadActions";
import { ArrowUpToLine } from "@/components/ui/icons";

// Custom event name for file drop communication
const HIPPIUS_DROP_EVENT = "hippius:file-drop";
const HIPPIUS_OPEN_MODAL_EVENT = "hippius:open-modal";

type AddButtonProps = {
  className?: string;
  /**
   * Icon size, so the glyph can be scaled with the row the button sits
   * in. The default matches this button's own 14px label; the drive
   * page's folder-list toolbar is a compact 12px row and passes a
   * smaller one. Left to the caller because the icon has to match its
   * NEIGHBOURS, which this component cannot see — a fixed `size-4` beside
   * a 12px sibling is what made the arrow look oversized.
   */
  iconClassName?: string;
  disabled?: boolean; // Optional external disabled state
  /**
   * The polled eligibility check already says uploads will be refused.
   * Click opens the upgrade dialog instead of the file picker.
   */
  storageBlocked?: boolean;
  defaultFolderLabel?: string | null;
  // When set, the dialog opens UploadFilesFlow in `mode="folder"` so files
  // are uploaded into a specific nested subfolder instead of the root of
  // the active sync folder. Used by the nested drive view (breadcrumb-based
  // folder browsing inside DriveContainer).
  nestedUpload?: NestedUploadTarget;
};

// Add ref interface for parent components to trigger the dialog.
// `openWithFiles` and `openWithPaths` are async because they perform a
// live credit-eligibility check via Rust before opening the dialog.
// Callers that don't care about the result can fire-and-forget; the
// hook handles surfacing the insufficient-credits dialog itself.
export interface AddButtonRef {
  /** Open the picker with nothing preselected, as clicking the button does. */
  open: () => Promise<void>;
  openWithFiles: (files: FileList) => Promise<void>;
  openWithPaths: (paths: string[]) => Promise<void>;
  isDialogOpen: () => boolean;
}

const AddButton = forwardRef<AddButtonRef, AddButtonProps>(
  (
    {
      className,
      iconClassName = "size-4",
      disabled: externalDisabled,
      storageBlocked = false,
      defaultFolderLabel,
      nestedUpload,
    },
    ref,
  ) => {
    // Keep state simple and isolated
    const [isOpen, setIsOpen] = useState(false);

    const [droppedFiles, setDroppedFiles] = useState<FileList | null>(null);
    const [droppedPaths, setDroppedPaths] = useState<string[] | null>(null);

    const uploadingState = useAtomValue(
      uploadToIpfsAndSubmitToBlockcahinRequestStateAtom,
    );
    const isLoading = uploadingState !== "idle";
    const hasConfiguredDrives = useAtomValue(hasConfiguredDrivesAtom);
    const { requireUploadRoom } = useCreditCheck();

    // Expose methods to parent components
    useImperativeHandle(
      ref,
      () => ({
        // Same gate order as the button's own click: eligibility first,
        // then a configured drive, so a surface that opens this by ref
        // cannot skip a check the button applies.
        // Toolbar / context menu: when blocked the control is disabled and
        // must not open the subscribe dialog. Drop paths use openWith*.
        open: async () => {
          if (storageBlocked) return;
          if (!(await requireUploadRoom("file-upload", false))) return;
          if (!hasConfiguredDrives) {
            toast.warning(
              "Set up a sync folder in Settings \u2192 Sync & Storage before uploading.",
            );
            return;
          }
          setDroppedFiles(null);
          setDroppedPaths(null);
          setIsOpen(true);
        },
        // Drag-and-drop: still explain via the dialog when blocked.
        openWithFiles: async (files: FileList) => {
          if (!(await requireUploadRoom("file-upload", storageBlocked))) return;
          if (!hasConfiguredDrives) {
            toast.warning(
              "Set up a sync folder in Settings \u2192 Sync & Storage before uploading.",
            );
            return;
          }
          setDroppedPaths(null);
          setDroppedFiles(files);
          setIsOpen(true);
        },
        openWithPaths: async (paths: string[]) => {
          if (!(await requireUploadRoom("file-upload", storageBlocked))) return;
          if (!hasConfiguredDrives) {
            toast.warning(
              "Set up a sync folder in Settings \u2192 Sync & Storage before uploading.",
            );
            return;
          }
          setDroppedFiles(null);
          setDroppedPaths(paths);
          setIsOpen(true);
        },
        isDialogOpen: () => isOpen,
      }),
      [isOpen, hasConfiguredDrives, requireUploadRoom, storageBlocked],
    );

    // Close and reset everything - use useCallback to prevent re-renders
    const closeDialog = useCallback(() => {
      setIsOpen(false);
      setDroppedFiles(null);
      setDroppedPaths(null);
    }, []);

    // Handle external events — same gate as the button click so a drop or
    // empty-state "Upload a File" cannot open the picker on a no-plan or
    // full account.
    useEffect(() => {
      const handleDroppedFiles = (event: Event) => {
        const customEvent = event as CustomEvent;
        if (customEvent.detail?.files && !isOpen) {
          void (async () => {
            if (!(await requireUploadRoom("file-upload", storageBlocked))) {
              return;
            }
            setDroppedFiles(customEvent.detail.files);
            setIsOpen(true);
          })();
        }
      };

      // Empty-state "Upload a File" click. When blocked that empty state
      // already swaps to Subscribe/Upgrade; do not open the dialog here.
      const handleOpenModal = () => {
        if (isOpen || storageBlocked) return;
        void (async () => {
          if (!(await requireUploadRoom("file-upload", false))) {
            return;
          }
          setDroppedFiles(null);
          setIsOpen(true);
        })();
      };

      window.addEventListener(HIPPIUS_DROP_EVENT, handleDroppedFiles);
      window.addEventListener(HIPPIUS_OPEN_MODAL_EVENT, handleOpenModal);

      return () => {
        window.removeEventListener(HIPPIUS_DROP_EVENT, handleDroppedFiles);
        window.removeEventListener(HIPPIUS_OPEN_MODAL_EVENT, handleOpenModal);
      };
    }, [isOpen, requireUploadRoom, storageBlocked]);

    return (
      <>
        <Button
          variant="primary"
          size="auto"
          className={cn(
            "h-[30px] px-3 py-[10px] rounded-[6px]",
            TOOLBAR_BUTTON_GAP,
            "font-geist text-[14px] tracking-[-0.28px] leading-[1.109]",
            className,
          )}
          onClick={async () => {
            // Toolbar: disabled when blocked. Do not open the dialog here.
            if (storageBlocked) return;
            if (!(await requireUploadRoom("file-upload", false))) return;
            if (!hasConfiguredDrives) {
              toast.warning(
                "Set up a sync folder in Settings → Sync & Storage before uploading.",
              );
              return;
            }
            setDroppedFiles(null);
            setDroppedPaths(null);
            setIsOpen(true);
          }}
          disabled={isLoading || externalDisabled || storageBlocked}
          title={
            storageBlocked
              ? "Storage full. Upgrade or subscribe to upload."
              : UPLOAD_FILE_LABEL
          }
        >
          {isLoading ? (
            <Loader2 className={cn("animate-spin", iconClassName)} />
          ) : (
            <>
              <ArrowUpToLine className={cn("shrink-0", iconClassName)} />
              {UPLOAD_FILE_BUTTON_LABEL}
            </>
          )}
        </Button>

        <UploadFileDialog
          open={isOpen}
          onClose={closeDialog}
          initialFiles={droppedFiles}
          initialPaths={droppedPaths}
          defaultFolderLabel={defaultFolderLabel}
          nestedUpload={nestedUpload}
        />
      </>
    );
  },
);

AddButton.displayName = "AddButton";

export default AddButton;
