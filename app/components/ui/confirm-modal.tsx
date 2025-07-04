// components/ui/confirm-modal.tsx
"use client";

import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Trash, HippiusLogo, CloseCircle } from "@/components/ui/icons";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Graphsheet } from ".";

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
  const accentBg = isDelete ? "bg-red-500" : "bg-primary-50";
  const Icon = isDelete ? Trash : HippiusLogo;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        {/* overlay */}
        <Dialog.Overlay className="fixed inset-0 bg-white/60 z-50" />

        {/* content */}
        <Dialog.Content
          className={`
            fixed left-1/2 top-1/2 z-50
            w-full max-w-sm sm:max-w-[488px] 
            -translate-x-1/2 -translate-y-1/2
            bg-white rounded-[8px]
            shadow-[0px_12px_36px_rgba(0,0,0,0.14)]
            p-4
          `}
        >
          {/* thick top bar on mobile */}
          <div
            className={cn(
              "absolute top-0 left-0 right-0 h-4 rounded-t-[8px] sm:hidden bg-primary-50"
            )}
          />

          {/* close button */}
          <Dialog.Close asChild className="sm:hidden">
            <button
              aria-label="Close"
              className="absolute top-11 right-4 text-grey-10 hover:text-grey-20"
            >
              <CloseCircle className="size-6" />
            </button>
          </Dialog.Close>

          {/* icon */}
          <div className="flex items-center sm:justify-center mb-4 mt-3 sm:mt-0">
            <div className="flex items-center sm:justify-center h-[56px] w-[56px] relative">
              <Graphsheet
                majorCell={{
                  lineColor: [31, 80, 189, 1.0],
                  lineWidth: 2,
                  cellDim: 40,
                }}
                minorCell={{
                  lineColor: [31, 80, 189, 1.0],
                  lineWidth: 2,
                  cellDim: 40,
                }}
                className="absolute w-full h-full top-0 bottom-0 left-0 duration-300 opacity-10 hidden sm:block"
              />
              <div
                className={cn(
                  "flex items-center justify-center size-8 rounded-[8px] relative",
                  accentBg
                )}
              >
                <Icon className="size-5 text-white" />
              </div>
            </div>
          </div>

          {/* title */}
          <Dialog.Title className="text-grey-10 text-[22px] sm:text-2xl font-medium text-center mb-2">
            {title}
          </Dialog.Title>

          {/* description */}
          <div className="text-base text-grey-50 text-center mb-4 px-2">
            {description}
          </div>

          {/* actions */}
          <div className="space-y-4">
            <button
              onClick={onConfirm}
              disabled={loading}
              className="w-full p-1 bg-primary-50 text-grey-100 rounded shadow border border-primary-40 hover:bg-primary-40 transition"
            >
              <div className="py-2.5 rounded border border-primary-40 text-lg">
                {loading ? (
                  <Loader2 className="mx-auto w-5 h-5 animate-spin" />
                ) : (
                  confirmText ||
                  (isDelete ? "Delete Sub Account" : "Confirm Transaction")
                )}
              </div>
            </button>

            <Dialog.Close asChild>
              <button
                onClick={onCancel}
                className="
                  w-full py-3.5 bg-grey-100 border border-grey-80 rounded text-grey-10
                  hover:bg-grey-80 transition
                  text-lg font-medium
                    hidden sm:block
                "
              >
                {cancelText || "Go Back"}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
