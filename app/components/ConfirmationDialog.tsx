"use client";

import React from "react";
import { ArrowRight } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import FramedDialog from "@/components/ui/FramedDialog";
import { cn } from "@/lib/utils";

/**
 * Generic FramedDialog-based confirmation modal — the canonical
 * confirm/delete dialog for the whole app.
 *
 * Mirrors the visual recipe of `page-sections/drive/DeleteConfirmationDialog`:
 *   - `maxWidth="max-w-[585px]"` and `contentClassName="sm:w-[405px]"` so
 *     FramedDialog's gray-ring + coloured-border + card padding chrome
 *     (~104px per side on `sm+`) leaves enough room for a 405px content area
 *     without `overflow-hidden` clipping the body text.
 *   - destructive flows get a coral pill (`bg-[#fc7d73]`) with white text +
 *     `ArrowRight` icon; primary flows get the standard blue Button.
 *   - cancel button is a transparent / grey-border ghost.
 *
 * `iconBgColor` doubles as the dialog frame's border colour so the badge,
 * border, and Button accent all share a tint.
 */
export interface ConfirmationDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onBack: () => void;
  button: React.ReactNode;
  text: React.ReactNode;
  heading: string;
  disableButton?: boolean;
  disableBackButton?: boolean;
  /** Semantic icon for the action — Trash for delete, PlayCircle for start, etc. */
  icon: React.ReactNode;
  /** Background of the icon badge AND (by default) the dialog frame border.
   * Use `bg-[#fc7d73]` for destructive actions; defaults to `bg-primary-50`. */
  iconBgColor?: string;
  borderClassName?: string;
  helperText?: React.ReactNode;
  /** Free-form content slot rendered between the helperText/text block and
   * the action buttons. Use this for things that don't fit the centered
   * helperText paragraph — e.g. drive's bullet list of files-to-delete. */
  children?: React.ReactNode;
  confirmVariant?: NonNullable<ButtonProps["variant"]>;
  confirmIcon?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  /** Override classes appended to the confirm Button. */
  confirmButtonClassName?: string;
  cancelButtonClassName?: string;
  contentClassName?: string;
  cardClassName?: string;
  maxWidth?: string;
}

const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  open,
  onClose,
  onConfirm,
  onBack,
  button,
  text,
  heading,
  disableButton = false,
  disableBackButton = false,
  icon,
  iconBgColor = "bg-primary-50",
  borderClassName,
  helperText,
  children,
  confirmVariant = "primary",
  confirmIcon = <ArrowRight className="ml-1.5 size-4" />,
  cancelLabel = "Cancel",
  confirmButtonClassName,
  cancelButtonClassName,
  contentClassName = "sm:w-[405px]",
  cardClassName,
  maxWidth = "max-w-[585px]",
}) => {
  // The destructive Button variant (`bg-[#fc7d73]`) has no baked-in text
  // colour — drive's DeleteConfirmationDialog overrides with `text-white`,
  // which is the canonical look for coral pills in this app.
  const isDestructive = confirmVariant === "destructive";
  const destructiveTextClass = isDestructive ? "text-white" : undefined;

  return (
    <FramedDialog
      open={open}
      onClose={onClose}
      title={heading}
      icon={icon}
      borderClassName={borderClassName ?? iconBgColor}
      iconBgClassName={iconBgColor}
      maxWidth={maxWidth}
      cardClassName={cn("bg-white dark:bg-[#161616]", cardClassName)}
      contentClassName={contentClassName}
    >
      <div className="font-geist">
        <p
          className={cn(
            "text-center text-base font-medium leading-[22px] tracking-[-0.32px] text-grey-20 dark:text-grey-dark-700",
            helperText ? "mb-2" : "mb-4",
          )}
        >
          {text}
        </p>

        {helperText ? (
          <div className="mb-4 text-center text-sm font-medium leading-5 text-grey-50 dark:text-grey-dark-700">
            {helperText}
          </div>
        ) : null}

        {children}

        <Button
          variant={confirmVariant}
          className={cn(
            "h-[52px] w-full",
            destructiveTextClass,
            confirmButtonClassName,
          )}
          onClick={onConfirm}
          disabled={disableButton}
        >
          {button}
          {confirmIcon}
        </Button>

        <Button
          // `defaultStable` keeps the rounded-md shape on hover — the
          // `default` variant morphs to a pill (hover:rounded-[52px])
          // which reads as a bug on a full-width cancel button.
          variant="defaultStable"
          className={cn(
            "mt-3 h-[52px] w-full border border-[#e3e3e3] !bg-transparent text-grey-10",
            "hover:!bg-grey-90",
            "dark:border-[#494949] dark:!bg-transparent dark:text-white dark:hover:!bg-[#2c2c2c]",
            cancelButtonClassName,
          )}
          onClick={onBack}
          disabled={disableBackButton}
        >
          {cancelLabel}
        </Button>
      </div>
    </FramedDialog>
  );
};

export default ConfirmationDialog;
