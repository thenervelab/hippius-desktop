import * as Dialog from "@radix-ui/react-dialog";
import React, { useState } from "react";
import { ArrowLeft } from "lucide-react";

import DialogContainer from "../../ui/dialog-container";
import { CardButton, Graphsheet, Icons } from "../../ui";
import { exportWalletAsZip } from "../../../lib/helpers/exportWallet";
import { toast } from "sonner";

export interface DeleteAccountConfirmationProps {
  open: boolean;
  onClose: () => void;
  onDelete: () => void;
  onBack: () => void;
  loading?: boolean;
}

const DeleteAccountConfirmation: React.FC<DeleteAccountConfirmationProps> = ({
  open,
  onClose,
  onDelete,
  onBack,
  loading = false,
}) => {
  const [isBackingUp, setIsBackingUp] = useState(false);

  const handleBackupData = async () => {
    setIsBackingUp(true);
    try {
      const success = await exportWalletAsZip();
      if (success) {
        toast.success("Backup file exported successfully", {
          duration: 3000,
        });
      }
    } catch (error) {
      console.error("Backup export failed:", error);
    } finally {
      setIsBackingUp(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContainer
        className="md:inset-0 md:m-auto
    md:w-[90vw] md:max-w-[428px] h-fit"
      >
        <Dialog.Title className="sr-only">Delete Account</Dialog.Title>
        {/* Top accent bar (only mobile) */}
        <div className="h-4 bg-primary-50 md:hidden block" />

        <div className="px-4">
          {/* Desktop Header */}
          <div className="text-2xl font-medium text-grey-10 hidden md:flex flex-col items-center justify-center pb-2 pt-4 gap-4">
            <div className="size-14 flex justify-center items-center relative">
              <Graphsheet
                majorCell={{
                  lineColor: [31, 80, 189, 1.0],
                  lineWidth: 2,
                  cellDim: 200,
                }}
                minorCell={{
                  lineColor: [49, 103, 211, 1.0],
                  lineWidth: 1,
                  cellDim: 20,
                }}
                className="absolute w-full h-full duration-500 opacity-30 z-0"
              />
              <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
              <div className="h-8 w-8 bg-error-50 rounded-lg flex items-center justify-center z-20">
                <Icons.Trash className="size-6 text-grey-100" />
              </div>
            </div>
            <span className="text-center text-2xl text-grey-10 font-medium">
              Are you sure you want to delete your account?
            </span>
          </div>

          {/* Mobile Header */}
          <div className="flex py-4 items-center justify-between text-grey-10 relative w-full md:hidden">
            <button onClick={onBack} className="mr-2">
              <ArrowLeft className="size-6 text-grey-10" />
            </button>
            <div className="text-lg font-medium relative">
              <span className="capitalize">Delete Account</span>
            </div>
            <button onClick={onClose}>
              <Icons.CloseCircle className="size-6 relative" />
            </button>
          </div>

          {/* Message */}
          <div className="font-medium text-base text-grey-20  mb-4 text-center ">
            Deleting your account will erase all Hippius data stored on this device. It won’t affect your on-chain account or data. Make sure you back up encrypted seed before you proceed.
          </div>

          {/* Backup Button */}
          <CardButton
            className="w-full mb-4 h-10"
            variant="secondary"
            onClick={handleBackupData}
            disabled={loading || isBackingUp}
          >
            <div className="flex items-center gap-2">
              <Icons.Backup className="size-5" />
              {isBackingUp ? "Backing up..." : "Back up your Data"}
            </div>
          </CardButton>

          {/* Delete Button */}
          <div className="flex gap-4 mb-6">
            <CardButton
              className="bg-primary-50 hover:bg-primary-40 transition text-white w-full font-medium"
              variant={"dialog"}
              onClick={onDelete}
              disabled={loading}
              loading={loading}
            >
              {loading ? "Deleting..." : "Delete Account"}
            </CardButton>

            {/* Go Back Button */}
            <CardButton
              className="w-full"
              variant="secondary"
              onClick={onBack}
              disabled={loading}
            >
              Go Back
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
};

export default DeleteAccountConfirmation;
