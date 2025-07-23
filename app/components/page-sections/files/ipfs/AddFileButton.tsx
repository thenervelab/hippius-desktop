import { CardButton } from "@/components/ui";
import {
  Edit2,
  PlusCircle,
  File,
  Clipboard,
  ArrowRight,
  ArrowLeft,
  Loader2
} from "lucide-react";

import {
  ReactNode,
  useState,
  useEffect,
  useMemo,
  forwardRef,
  useImperativeHandle,
  useCallback
} from "react";

import * as Dialog from "@radix-ui/react-dialog";
import { FC } from "react";

import UploadFilesFlow from "./upload-files-flow";
import { Icons, P, AbstractIconWrapper } from "@/components/ui";
import { uploadToIpfsAndSubmitToBlockcahinRequestStateAtom } from "@/components/page-sections/files/ipfs/atoms/query-atoms";
import { useAtomValue } from "jotai";
import AddCidFlow from "./add-cid-flow";
import AddCSVFlow from "./add-csv-flow";
import { cn } from "@/lib/utils";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";

// Custom event name for file drop communication
const HIPPIUS_DROP_EVENT = "hippius:file-drop";
const HIPPIUS_OPEN_MODAL_EVENT = "hippius:open-modal";

type FileAddStates = "upload-file" | "upload-csv" | "add-cid";

// Move this outside component to prevent recreation
const getDialogTitle = (addState: FileAddStates | null) => {
  switch (addState) {
    case "add-cid":
      return "Add CID Manually";
    case "upload-file":
      return "Upload Your Files";
    case "upload-csv":
      return "Upload Your CSV File";
    default:
      return "Add a File";
  }
};

// Move this outside component to prevent recreation
const FileAddoptionButton: FC<{
  icon: ReactNode;
  label: string;
  action: () => void;
}> = ({ icon, label, action }) => {
  return (
    <div
      onClick={action}
      className="p-2 flex hover:opacity-50 duration-300 text-grey-50 items-center gap-2 font-medium w-full border border-grey-80 rounded cursor-pointer"
    >
      <AbstractIconWrapper className="size-6 p-0 flex items-center justify-center">
        <span className="relative text-primary-50 size-4 flex items-center justify-center">
          {icon}
        </span>
      </AbstractIconWrapper>
      {label}
      <ArrowRight className="size-4 ml-auto" />
    </div>
  );
};

type AddButtonProps = {
  className?: string;
};

// Add ref interface for parent components to trigger the dialog
export interface AddButtonRef {
  openWithFiles: (files: FileList) => void;
}

const AddButton = forwardRef<AddButtonRef, AddButtonProps>(
  ({ className }, ref) => {
    // Keep state simple and isolated
    const [isOpen, setIsOpen] = useState(false);
    const [currentStep, setCurrentStep] = useState<"options" | FileAddStates>(
      "options"
    );
    const [droppedFiles, setDroppedFiles] = useState<FileList | null>(null);

    const uploadingState = useAtomValue(
      uploadToIpfsAndSubmitToBlockcahinRequestStateAtom
    );
    const isLoading = uploadingState !== "idle";

    const activeSubMenuItem = useAtomValue(activeSubMenuItemAtom);
    const isPrivateView = activeSubMenuItem === "Private";

    // Expose methods to parent components
    useImperativeHandle(
      ref,
      () => ({
        openWithFiles: (files: FileList) => {
          setDroppedFiles(files);
          setCurrentStep("upload-file");
          setIsOpen(true);
        }
      }),
      []
    );

    // Memoize title to prevent recalculation
    const title = useMemo(() => {
      if (currentStep === "options") return "Add a File";
      return getDialogTitle(currentStep);
    }, [currentStep]);

    // Close and reset everything - use useCallback to prevent re-renders
    const closeDialog = useCallback(() => {
      setIsOpen(false);
      setCurrentStep(isPrivateView ? "upload-file" : "options");
      setDroppedFiles(null);
    }, [isPrivateView]);

    // Memoize step change handlers to prevent re-renders
    const handleStepChange = useCallback((step: FileAddStates) => {
      setCurrentStep(step);
    }, []);

    const handleBackToOptions = useCallback(() => {
      setCurrentStep("options");
      setDroppedFiles(null);
    }, [closeDialog]);

    // Handle external events
    useEffect(() => {
      const handleDroppedFiles = (event: Event) => {
        const customEvent = event as CustomEvent;
        if (customEvent.detail?.files && !isOpen) {
          setDroppedFiles(customEvent.detail.files);
          setCurrentStep("upload-file");
          setIsOpen(true);
        }
      };

      const handleOpenModal = () => {
        if (!isOpen) {
          setCurrentStep(isPrivateView ? "upload-file" : "options");
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
    }, [isOpen, isPrivateView]);

    // Render current step content - memoized to prevent unnecessary re-renders
    const renderStepContent = useMemo(() => {
      if (currentStep === "options") {
        return (
          <div className="w-full text-grey-50">
            <P size="sm">Choose how you want to upload your file</P>
            <div className="flex flex-col gap-y-2 mt-4 w-full">
              <FileAddoptionButton
                icon={<File />}
                label="Upload File to IPFS"
                action={() => handleStepChange("upload-file")}
              />
              <FileAddoptionButton
                icon={<Edit2 />}
                label="Add CID Manually"
                action={() => handleStepChange("add-cid")}
              />
              <FileAddoptionButton
                icon={<Clipboard />}
                label="Upload CSV File"
                action={() => handleStepChange("upload-csv")}
              />
            </div>
            <div className="mt-4 text-xs text-grey-70 font-semibold text-center">
              Your files are stored on IPFS and registered on the Hippius
              blockchain.
            </div>
          </div>
        );
      }

      // Render specific flows - only render the current step to prevent mounting all components
      switch (currentStep) {
        case "upload-file":
          return (
            <UploadFilesFlow
              key="upload-file"
              reset={closeDialog}
              isPrivateView={isPrivateView}
              initialFiles={droppedFiles}
            />
          );
        case "add-cid":
          return <AddCidFlow key="add-cid" reset={closeDialog} />;
        case "upload-csv":
          return <AddCSVFlow key="upload-csv" reset={closeDialog} />;
        default:
          return null;
      }
    }, [currentStep, droppedFiles, closeDialog, handleStepChange]);

    return (
      <>
        <CardButton
          className={cn("h-[40px] w-fit p-1", className)}
          onClick={() => {
            setCurrentStep(isPrivateView ? "upload-file" : "options");
            setDroppedFiles(null);
            setIsOpen(true);
          }}
          disabled={isLoading}
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
            <Dialog.Overlay className="bg-white/70 fixed p-4 z-30 top-0 w-full h-full flex items-center justify-center data-[state=open]:animate-fade-in-0.3">
              <Dialog.Content className="border shadow-dialog bg-white flex flex-col max-w-[428px] border-grey-80 bg-background-1 rounded-[8px] overflow-hidden w-full relative data-[state=open]:animate-scale-in-95-0.2">
                <Dialog.Title className="hidden">{title}</Dialog.Title>

                {/* Header */}
                <div
                  className={cn(
                    "flex p-4 items-center text-grey-10 relative",
                    currentStep === "options" && "pb-0"
                  )}
                >
                  {currentStep !== "options" && !isPrivateView && (
                    <button
                      type="button"
                      onClick={handleBackToOptions}
                      className="mr-2"
                    >
                      <ArrowLeft className="size-6 text-grey-10" />
                    </button>
                  )}
                  <div className="lg:text-xl flex w-full 2xl:text-2xl font-medium relative">
                    <span className="capitalize">{title}</span>
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

                {/* Content */}
                <div className="grow max-h-[calc(85vh-120px)] p-4 pt-2 overflow-y-auto">
                  {renderStepContent}
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
