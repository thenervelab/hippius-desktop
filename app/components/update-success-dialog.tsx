import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import React from "react";
import { ArrowLeft } from "lucide-react";

import DialogContainer from "./ui/dialog-container";
import { CardButton, Graphsheet, Icons } from "./ui";

export interface DeleteConfirmationDialogProps {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  button: string;
  heading: string;
  disableButton?: boolean;
}

const UpdateSuccessDialog: React.FC<DeleteConfirmationDialogProps> = ({
  open,
  onClose,
  onDone,
  button,

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

              <Icons.Tick className="size-9 text-grey-100" />
            </div>
            <span className="text-3xl font-medium text-grey-10 text-center mb-16">
              {heading}
            </span>
          </div>

          {/* Mobile Header */}
          <div className="flex py-4 items-center justify-between text-grey-10 relative w-full md:hidden">
            <div className="text-lg font-medium relative">
              <span className="capitalize">{heading}</span>
            </div>
            <button onClick={onClose}>
              <Icons.CloseCircle className="size-6 relative" />
            </button>
          </div>

          {/* Buttons */}
          <CardButton
            className="bg-primary-50 py-4 mb-5 hover:bg-primary-40 transition text-white w-full font-medium"
            size={"lg"}
            variant={"dialog"}
            onClick={onDone}
            appendToStart
            disabled={disableButton}
          >
            {button}
          </CardButton>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
};

export default UpdateSuccessDialog;
