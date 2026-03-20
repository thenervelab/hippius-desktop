"use client";

import React, { useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { CardButton, Graphsheet, Icons } from ".";
import DialogContainer from "./DialogContainer";
import { CloseCircle, HippiusLogo } from "./icons";

/* ------------------------------------------------------------------ */
/*  Unified ConfirmDialog                                              */
/*                                                                     */
/*  Two visual modes controlled by `mode`:                             */
/*    "alert"   – compact AlertDialog with icon + text (default)       */
/*    "branded" – full branded dialog with Graphsheet header           */
/* ------------------------------------------------------------------ */

interface BaseProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void | Promise<void>;
  isLoading?: boolean;
}

interface AlertModeProps extends BaseProps {
  mode?: "alert";
  onOpenChange: (open: boolean) => void;
  variant?: "danger" | "warning" | "info";
  /** Not used in alert mode */
  icon?: never;
  iconBgColor?: never;
  onBack?: never;
  onCancel?: never;
  brandedVariant?: never;
}

interface BrandedModeProps extends BaseProps {
  mode: "branded";
  /** Called when dialog should close (cancel / close button / back) */
  onCancel: () => void;
  /** Optional back button handler (mobile). Defaults to onCancel. */
  onBack?: () => void;
  /** Custom icon rendered inside the header badge */
  icon?: React.ReactNode;
  /** Background color class for the icon badge. Default: "bg-primary-50" */
  iconBgColor?: string;
  /** Branded sub-variant for default icon/color when no custom icon given */
  brandedVariant?: "create" | "delete" | "close";
  /** Not used in branded mode */
  onOpenChange?: never;
  variant?: never;
}

export type ConfirmDialogProps = AlertModeProps | BrandedModeProps;

export const ConfirmDialog: React.FC<ConfirmDialogProps> = (props) => {
  const mode = props.mode ?? "alert";

  if (mode === "branded") {
    return <BrandedDialog {...(props as BrandedModeProps)} />;
  }

  return <AlertModeDialog {...(props as AlertModeProps)} />;
};

/* ------------------------------------------------------------------ */
/*  Alert mode (compact, AlertDialog-based)                            */
/* ------------------------------------------------------------------ */

const AlertModeDialog: React.FC<AlertModeProps> = ({
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
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] bg-grey-100 rounded-lg shadow-xl p-6 w-full max-w-md focus:outline-none"
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

/* ------------------------------------------------------------------ */
/*  Branded mode (Graphsheet header, DialogContainer)                   */
/* ------------------------------------------------------------------ */

const BrandedDialog: React.FC<BrandedModeProps> = ({
  open,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Go Back",
  onConfirm,
  onCancel,
  onBack,
  icon,
  iconBgColor,
  brandedVariant,
  isLoading = false,
}) => {
  const handleBack = onBack ?? onCancel;

  // Resolve icon and bg color
  const isDelete = brandedVariant === "delete";
  const resolvedBgColor =
    iconBgColor ?? (isDelete ? "bg-error-50" : "bg-primary-50");

  let resolvedIcon = icon;
  if (!resolvedIcon) {
    if (brandedVariant === "delete") {
      resolvedIcon = <Icons.Trash className="size-6 text-grey-100" />;
    } else if (brandedVariant === "close") {
      resolvedIcon = <CloseCircle className="size-6 text-white" />;
    } else if (brandedVariant === "create") {
      resolvedIcon = <HippiusLogo className="size-8 text-grey-100 rounded-lg" />;
    } else {
      resolvedIcon = <Icons.Trash className="size-6 text-grey-100" />;
    }
  }

  const accentBarColor = isDelete ? "bg-error-50" : "bg-primary-50";
  const confirmVariant = isDelete ? "error" : "primary";

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContainer
        className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit"
      >
        <Dialog.Title className="sr-only">{title}</Dialog.Title>

        {/* Top accent bar (mobile only) */}
        <div className={cn("h-4 md:hidden block", accentBarColor)} />

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
              <div
                className={cn(
                  "h-8 w-8 rounded-lg flex items-center justify-center z-20",
                  resolvedBgColor
                )}
              >
                {resolvedIcon}
              </div>
            </div>
            <span className="text-center text-2xl text-grey-10 font-medium">
              {title}
            </span>
          </div>

          {/* Mobile Header */}
          <div className="flex py-4 items-center justify-between text-grey-10 relative w-full md:hidden">
            <button onClick={handleBack} className="mr-2">
              <ArrowLeft className="size-6 text-grey-10" />
            </button>
            <div className="text-lg font-medium relative">
              <span className="capitalize">{title}</span>
            </div>
            <button onClick={onCancel}>
              <Icons.CloseCircle className="size-6 relative" />
            </button>
          </div>

          {/* Message */}
          <div className="font-medium text-base text-grey-50 max-w-[320px] flex mx-auto w-full text-center mb-4">
            {description}
          </div>

          {/* Buttons */}
          <div className="flex flex-col gap-4 mb-4">
            <CardButton
              className="text-base w-full"
              variant={confirmVariant}
              onClick={onConfirm}
              disabled={isLoading}
              loading={isLoading}
            >
              {isLoading ? "Processing..." : confirmText}
            </CardButton>

            <CardButton
              variant="secondary"
              className="bg-grey-100 border border-grey-80 text-grey-10 w-full text-lg font-medium h-12 hover:bg-grey-80 transition"
              onClick={handleBack}
              disabled={isLoading}
            >
              {cancelText}
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
};

export default ConfirmDialog;
