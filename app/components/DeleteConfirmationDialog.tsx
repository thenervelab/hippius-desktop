import * as Dialog from "@radix-ui/react-dialog";
import React from "react";
import { ArrowLeft } from "lucide-react";

import DialogContainer from "./ui/DialogContainer";
import { CardButton, Graphsheet, Icons } from "./ui";

export interface DeleteConfirmationDialogProps {
  open: boolean;
  onClose: () => void;
  onDelete: () => void;
  onBack: () => void;
  button: string;
  text: string;
  heading: string;
  disableButton?: boolean;
}

const DeleteConfirmationDialog: React.FC<DeleteConfirmationDialogProps> = ({
  open,
  onClose,
  onDelete,
  onBack,
  button,
  text,
  heading,
  disableButton = false,
}) => {
  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContainer
        className="md:inset-0 md:m-auto
    md:w-[90vw] md:max-w-[428px] h-fit"
      >
        <Dialog.Title className="sr-only">{heading}</Dialog.Title>
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
            <span>{heading}</span>
          </div>

          {/* Mobile Header */}
          <div className="flex py-4 items-center justify-between text-grey-10 relative w-full md:hidden">
            <button onClick={onBack} className="mr-2">
              <ArrowLeft className="size-6 text-grey-10" />
            </button>
            <div className="text-lg font-medium relative">
              <span className="capitalize">{heading}</span>
            </div>
            <button onClick={onClose}>
              <Icons.CloseCircle className="size-6 relative" />
            </button>
          </div>

          {/* Message */}
          <div className="font-medium text-base text-grey-20 text-center mb-4 ">
            {text}
          </div>

          {/* Buttons */}
          <CardButton
            className="bg-primary-50 py-4 hover:bg-primary-40 transition text-white w-full font-medium"
            size={"lg"}
            variant={"primary"}
            onClick={onDelete}
            appendToStart
            disabled={disableButton}
          >
            {button}
          </CardButton>
          <CardButton
            variant="secondary"
            className="bg-grey-100 border border-grey-80 text-grey-10 w-full my-4 text-lg font-medium h-12 hover:bg-grey-80 transition"
            onClick={onBack}
          >
            Go Back
          </CardButton>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
};

export default DeleteConfirmationDialog;
