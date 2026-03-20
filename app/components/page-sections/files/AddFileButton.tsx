import { CardButton } from "@/components/ui";
import {
  PlusCircle,
  Loader2
} from "lucide-react";

import {
  useState,
  useEffect,
  useMemo,
  forwardRef,
  useImperativeHandle,
  useCallback
} from "react";

import * as Dialog from "@radix-ui/react-dialog";

import UploadFilesFlow from "./upload-files-flow";
import { Icons } from "@/components/ui";
import { uploadToIpfsAndSubmitToBlockcahinRequestStateAtom } from "@/app/components/page-sections/files/atoms/query-atoms";
import { useAtomValue } from "jotai";
import PrivacyBadge from "@/components/ui/PrivacyBadge";

import { cn } from "@/lib/utils";
import { SyncPausedAlert, IS_SYNC_PAUSED } from "@/components/ui/SyncPausedAlert";
import { syncEngineStatusAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { toast } from "sonner";

// Custom event name for file drop communication
const HIPPIUS_DROP_EVENT = "hippius:file-drop";
const HIPPIUS_OPEN_MODAL_EVENT = "hippius:open-modal";





type AddButtonProps = {
  className?: string;
  disabled?: boolean; // Optional external disabled state
  defaultFolderLabel?: string | null;
};

// Add ref interface for parent components to trigger the dialog
export interface AddButtonRef {
  openWithFiles: (files: FileList) => void;
  openWithPaths: (paths: string[]) => void;
  isDialogOpen: () => boolean;
}

const AddButton = forwardRef<AddButtonRef, AddButtonProps>(
  ({ className, disabled: externalDisabled, defaultFolderLabel }, ref) => {
    // Keep state simple and isolated
    const [isOpen, setIsOpen] = useState(false);

    const [droppedFiles, setDroppedFiles] = useState<FileList | null>(null);
    const [droppedPaths, setDroppedPaths] = useState<string[] | null>(null);

    const uploadingState = useAtomValue(
      uploadToIpfsAndSubmitToBlockcahinRequestStateAtom
    );
    const isLoading = uploadingState !== "idle";
    const syncEngineStatus = useAtomValue(syncEngineStatusAtom);

    // Expose methods to parent components
    useImperativeHandle(
      ref,
      () => ({
        openWithFiles: (files: FileList) => {
          if (syncEngineStatus === "stopped") {
            toast.warning("Syncing is stopped. Resume syncing from Settings \u2192 Sync & Storage before uploading files.");
            return;
          }
          setDroppedPaths(null);
          setDroppedFiles(files);
          setIsOpen(true);
        },
        openWithPaths: (paths: string[]) => {
          if (syncEngineStatus === "stopped") {
            toast.warning("Syncing is stopped. Resume syncing from Settings \u2192 Sync & Storage before uploading files.");
            return;
          }
          setDroppedFiles(null);
          setDroppedPaths(paths);
          setIsOpen(true);
        },
        isDialogOpen: () => isOpen
      }),
      [isOpen, syncEngineStatus]
    );

    // Memoize title to prevent recalculation
    const title = useMemo(() => {
      return "Upload Your Files";
    }, []);

    // Close and reset everything - use useCallback to prevent re-renders
    const closeDialog = useCallback(() => {
      setIsOpen(false);
      setDroppedFiles(null);
      setDroppedPaths(null);
    }, []);



    // Handle external events
    useEffect(() => {
      const handleDroppedFiles = (event: Event) => {
        const customEvent = event as CustomEvent;
        if (customEvent.detail?.files && !isOpen) {
          setDroppedFiles(customEvent.detail.files);
          setIsOpen(true);
        }
      };

      const handleOpenModal = () => {
        if (!isOpen) {
          setDroppedFiles(null);
          setIsOpen(true);
        }
      };

      window.addEventListener(HIPPIUS_DROP_EVENT, handleDroppedFiles);
      window.addEventListener(HIPPIUS_OPEN_MODAL_EVENT, handleOpenModal);

      return () => {
        window.removeEventListener(HIPPIUS_DROP_EVENT, handleDroppedFiles);
        window.removeEventListener(HIPPIUS_OPEN_MODAL_EVENT, handleOpenModal);
      };
    }, [isOpen]);

    // Render current step content - memoized to prevent unnecessary re-renders
    const renderStepContent = useMemo(() => {
      // Always show upload-file flow for both private and public
      return (
        <UploadFilesFlow
          key="upload-file"
          reset={closeDialog}
          initialFiles={droppedFiles}
          initialPaths={droppedPaths}
          defaultFolderLabel={defaultFolderLabel}
        />
      );
    }, [
      droppedFiles,
      droppedPaths,
      closeDialog,
      defaultFolderLabel
    ]);

    return (
      <>
        <CardButton
          className={cn("h-10 w-fit p-1", externalDisabled && "opacity-50 cursor-not-allowed", className)}
          onClick={() => {
            if (IS_SYNC_PAUSED) return;
            if (syncEngineStatus === "stopped") {
              toast.warning("Syncing is stopped. Resume syncing from Settings → Sync & Storage before uploading files.");
              return;
            }
            setDroppedFiles(null);
            setDroppedPaths(null);
            setIsOpen(true);
          }}
          disabled={isLoading || externalDisabled}
        >
          <div className="flex items-center gap-2 text-grey-100 text-base font-medium p-2">
            <div>
              <PlusCircle className="size-4" />
            </div>
            <span className="flex items-center">
              {isLoading ? (
                <Loader2 className="animate-spin size-4" />
              ) : (
                " Upload File"
              )}
            </span>
          </div>
        </CardButton>

        <Dialog.Root
          open={isOpen}
          onOpenChange={(open) => {
            if (!open) closeDialog();
            else setIsOpen(true);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="bg-white/60 fixed p-4 z-30 top-0 w-full h-full flex items-center justify-center data-[state=open]:animate-fade-in-0.3">
              <Dialog.Content className="border shadow-dialog bg-white flex flex-col max-w-[428px] border-grey-80 bg-background-1 rounded-[8px] overflow-hidden w-full relative data-[state=open]:animate-scale-in-95-0.2">
                <Dialog.Title className="hidden">{title}</Dialog.Title>

                {/* Header */}
                <div className="flex p-4 items-center text-grey-10 relative">
                  <div className="lg:text-xl flex w-full items-center gap-2 2xl:text-2xl font-medium relative">
                    <span className="capitalize">{title}</span>
                    <PrivacyBadge variant="file" />
                  </div>
                  <button
                    type="button"
                    className="ml-auto"
                    onClick={closeDialog}
                  >
                    <Icons.CloseCircle
                      className="size-6 relative"
                      strokeWidth={2.5}
                    />
                  </button>
                </div>

                {/* Sync Paused Alert */}
                {IS_SYNC_PAUSED && (
                  <div className="px-4">
                    <SyncPausedAlert variant="inline" />
                  </div>
                )}

                {/* Content */}
                <div className="grow max-h-[calc(85vh-120px)] p-4 pt-2 overflow-y-auto">
                  {!IS_SYNC_PAUSED && renderStepContent}
                  {IS_SYNC_PAUSED && (
                    <div className="text-center py-8 text-grey-60">
                      <p>File uploads are temporarily paused while we transition to our new sync engine.</p>
                      <p className="mt-2 text-sm">This will be available again in the coming days.</p>
                    </div>
                  )}
                </div>
              </Dialog.Content>
            </Dialog.Overlay>
          </Dialog.Portal>
        </Dialog.Root>
      </>
    );
  }
);

AddButton.displayName = "AddButton";

export default AddButton;
