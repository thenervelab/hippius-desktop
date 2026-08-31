"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { CardButton, Graphsheet, Icons } from ".";
import { Button } from "@/components/ui/button";
import FramedDialog from "@/components/ui/FramedDialog";
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
  /**
   * When true the confirm button is shown but cannot fire `onConfirm`.
   * Alert mode only — `BrandedDialog` renders a `CardButton` that does not
   * read it, so declaring it on the shared base let a branded caller pass it
   * and silently get a live confirm button.
   */
  confirmDisabled?: boolean;
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
  confirmDisabled?: never;
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
  confirmDisabled = false,
}) => {
  const [confirming, setConfirming] = useState(false);
  const busy = isLoading || confirming;

  const handleConfirm = async () => {
    if (confirmDisabled) return;
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
      onOpenChange(false);
    }
  };

  // Per-variant accent (icon badge + frame) + the matching confirm Button.
  // `danger` uses the destructive (#fc7d73) coral so the frame + icon badge
  // read as one with the app-wide Exclude/Delete action (e.g. FailedFilesModal)
  // rather than the brighter error-50 red.
  const variantStyles = {
    danger: { accent: "bg-[#fc7d73]", confirmVariant: "destructive" as const },
    warning: { accent: "bg-warning-50", confirmVariant: "primary" as const },
    info: { accent: "bg-primary-50", confirmVariant: "primary" as const },
  };
  const styles = variantStyles[variant];

  // Render on the shared FramedDialog (decoration grid + centered icon badge +
  // title + close button) so this confirm matches every other dialog and gets
  // light/dark theming for free. The X / Escape / click-outside all cancel.
  return (
    <FramedDialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={title}
      icon={<AlertTriangle className="size-5 text-white" />}
      iconBgClassName={styles.accent}
      borderClassName={styles.accent}
      maxWidth="max-w-[560px]"
      cardClassName="bg-white dark:bg-[#161616]"
    >
      <div className="mb-6 text-center text-sm font-medium leading-relaxed text-grey-50 dark:text-grey-dark-700">
        {description}
      </div>

      <div className="flex gap-3">
        <Button
          variant="defaultStable"
          className="h-[52px] flex-1 border border-[#e3e3e3] !bg-transparent text-grey-10 hover:!bg-grey-90 dark:border-[#494949] dark:!bg-transparent dark:text-white dark:hover:!bg-[#2c2c2c]"
          onClick={() => onOpenChange(false)}
          disabled={busy}
        >
          {cancelText}
        </Button>
        <Button
          variant={styles.confirmVariant}
          className={cn(
            "h-[52px] flex-1",
            styles.confirmVariant === "destructive" && "text-white",
          )}
          onClick={handleConfirm}
          loading={busy}
          disabled={busy || confirmDisabled}
        >
          {confirmText}
        </Button>
      </div>
    </FramedDialog>
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
        className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[26.75rem] h-fit"
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
          <div className="font-medium text-base text-grey-50 max-w-[20rem] flex mx-auto w-full text-center mb-4">
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
