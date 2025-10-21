// components/ui/confirm-modal.tsx
"use client";

import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { HippiusLogo, CloseCircle } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { Graphsheet, CardButton, Icons } from ".";
import DialogContainer from "./DialogContainer";

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  variant: "create" | "delete";
  confirmText?: string;
  cancelText?: string;
}

export default function ConfirmModal({
  open,
  title,
  description,
  loading,
  onConfirm,
  onCancel,
  variant,
  confirmText,
  cancelText,
}: ConfirmModalProps) {
  const isDelete = variant === "delete";

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit">
        <Dialog.Title className="sr-only">{title}</Dialog.Title>

        {/* Top accent bar (mobile only) */}
        <div className={cn("h-4 md:hidden block", isDelete ? "bg-error-50" : "bg-primary-50")} />

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
              <div className="bg-white-cloud-gradient-lg absolute w-full h-full z-10" />
              <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center z-20", isDelete ? "bg-error-50" : "bg-primary-50")}>
                {isDelete ? (
                  <Icons.Trash className="size-6 text-grey-100" />
                ) : (
                  <HippiusLogo className="size-8 text-grey-100 rounded-lg" />
                )}
              </div>
            </div>
            <span className="text-center text-2xl text-grey-10 font-medium">
              {title}
            </span>
          </div>

          {/* Mobile Header */}
          <div className="flex py-4 items-center justify-between text-grey-10 relative w-full md:hidden">
            <div className="text-lg font-medium relative mx-auto">
              <span className="capitalize">{title}</span>
            </div>
            <button onClick={onCancel}>
              <CloseCircle className="size-6 relative" />
            </button>
          </div>

          {/* Message */}
          <div className="font-medium text-base text-grey-20 mb-4 text-center">
            {description}
          </div>

          {/* Action Buttons */}
          <div className="flex gap-4 mb-6">
            <CardButton
              className="text-base w-full"
              variant={isDelete ? "error" : "primary"}
              onClick={onConfirm}
              disabled={loading}
              loading={loading}
            >
              {loading ? "Processing..." : (confirmText || (isDelete ? "Delete API Key" : "Yes Proceed"))}
            </CardButton>

            <CardButton
              className="w-full"
              variant="secondary"
              onClick={onCancel}
              disabled={loading}
            >
              {cancelText || "No, Go Back"}
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
}
