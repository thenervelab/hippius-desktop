"use client";

import React, { useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void | Promise<void>;
  variant?: "danger" | "warning" | "info";
  isLoading?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  variant = "warning",
  isLoading = false,
}) => {
  const [confirming, setConfirming] = useState(false);

  const handleConfirm = async (e: React.MouseEvent) => {
    // Prevent AlertDialog from auto-closing so we can await the async action
    e.preventDefault();
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
      onOpenChange(false);
    }
  };

  const variantStyles = {
    danger: {
      iconColor: "text-error-50",
      bgColor: "bg-error-95",
      confirmBtn:
        "bg-error-50 hover:bg-error-40 text-white border-error-40",
    },
    warning: {
      iconColor: "text-warning-50",
      bgColor: "bg-warning-95",
      confirmBtn:
        "bg-primary-50 hover:bg-primary-40 text-white border-primary-40",
    },
    info: {
      iconColor: "text-primary-50",
      bgColor: "bg-primary-95",
      confirmBtn:
        "bg-primary-50 hover:bg-primary-40 text-white border-primary-40",
    },
  };

  const styles = variantStyles[variant];
  const busy = isLoading || confirming;

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <AlertDialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] bg-white rounded-lg shadow-xl p-6 w-full max-w-md focus:outline-none"
        >
          <div className="flex items-start gap-4">
            <div
              className={cn(
                "p-2 rounded-lg flex-shrink-0",
                styles.bgColor
              )}
            >
              <AlertTriangle className={cn("size-5", styles.iconColor)} />
            </div>
            <div className="flex-1 min-w-0">
              <AlertDialog.Title className="text-lg font-semibold text-grey-10 mb-2">
                {title}
              </AlertDialog.Title>
              <AlertDialog.Description className="text-sm text-grey-60 leading-relaxed">
                {description}
              </AlertDialog.Description>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <AlertDialog.Cancel
              className="flex-1 py-2.5 px-4 text-sm font-medium rounded border border-grey-80 bg-grey-90 hover:bg-grey-80 text-grey-10 transition-colors disabled:opacity-50"
              disabled={busy}
            >
              {cancelText}
            </AlertDialog.Cancel>
            <AlertDialog.Action
              className={cn(
                "flex-1 py-2.5 px-4 text-sm font-medium rounded border transition-colors disabled:opacity-50",
                styles.confirmBtn
              )}
              onClick={handleConfirm}
              disabled={busy}
            >
              {busy ? "Please wait..." : confirmText}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
};
