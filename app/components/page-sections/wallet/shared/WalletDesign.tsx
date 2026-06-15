import React, { type ReactNode } from "react";

import FramedDialog from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* Shared design tokens + dialog primitives used by every wallet flow
 * (Send / Receive / Stake / Unstake / Withdraw / Bridge / Address
 * book). Ported from the hippius-web console so the wallet redesign
 * mirrors the same surface across both products.
 *
 * Three exports cover most call sites:
 *   - <WalletDialogShell> wraps a FramedDialog with the wallet's blue
 *     border, brand-blue icon badge, and tightened content padding.
 *   - <WalletDialogCard> renders the inset white card used inside
 *     dialog bodies (review screens, amount cards, etc.).
 *   - <WalletDialogFooter> renders the standard primary + cancel
 *     button pair with the project's safe `defaultStable`/`primary`
 *     variants (NEVER the default `default` variant — that has the
 *     hover-to-pill 52px radius bug per project memory).
 *
 * Constants below are exported so card-shaped surfaces outside dialogs
 * (balance widget, stake widget, etc.) can reuse the same look. */

export const walletSectionClassName =
  "rounded-[12px] border border-[#e3e3e3] bg-[#fefefe] shadow-[0px_1px_0px_0px_white] dark:border-[#313131] dark:bg-[#161616] dark:shadow-none";

export const walletInsetClassName =
  "rounded-[10px] border border-[#e3e3e3] bg-white shadow-[0px_1px_0px_0px_white] dark:border-[#313131] dark:bg-[#1a1a1a] dark:shadow-none";

export const walletTabClassName =
  "inline-flex h-[36px] items-center rounded-[8px] border px-4 font-geist text-[13px] font-medium tracking-[-0.26px] transition-colors";

export const walletTableVariablesClassName =
  "[--table-row-height:36px] [--table-cell-padding-x:10px] [--table-font-size:12px] [--table-line-height:16px] [--table-header-font-size:10px] [--table-header-line-height:14px]";

interface WalletDialogShellProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  icon: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
  contentClassName?: string;
  borderClassName?: string;
  iconBgClassName?: string;
  cardClassName?: string;
  /** Margin-top override on the title (gap between icon and title). */
  iconTitleGap?: string;
  /** Margin-top override on the description (gap between title and
   * description). Default `-mt-4` matches console's tight layout. */
  titleDescriptionGap?: string;
}

export const WalletDialogShell: React.FC<WalletDialogShellProps> = ({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  maxWidth = "max-w-[560px]",
  contentClassName,
  borderClassName = "bg-[#3167dd]",
  iconBgClassName = "bg-[#3167dd]",
  cardClassName = "bg-[#fbfbfb] dark:bg-[#1a1a1a]",
  iconTitleGap,
  titleDescriptionGap = "-mt-4",
}) => {
  return (
    <FramedDialog
      open={open}
      onClose={onClose}
      title={title}
      icon={icon}
      maxWidth={maxWidth}
      borderClassName={borderClassName}
      iconBgClassName={iconBgClassName}
      contentClassName={cn("px-4 py-3 sm:px-5 sm:py-4", contentClassName)}
      cardClassName={cardClassName}
      titleClassName={iconTitleGap}
    >
      {description ? (
        <p
          className={cn(
            "mb-3 text-center font-medium text-base leading-5 tracking-[-0.28px] text-[#7D7D7D] dark:text-grey-dark-600 sm:text-lg sm:leading-6 sm:tracking-[-0.3px]",
            titleDescriptionGap,
          )}
        >
          {description}
        </p>
      ) : null}
      {children}
      {footer ? <div className="mt-6">{footer}</div> : null}
    </FramedDialog>
  );
};

export const WalletDialogCard: React.FC<{
  children: ReactNode;
  className?: string;
}> = ({ children, className }) => {
  return (
    <div
      className={cn(
        "rounded-[12px] border border-[#e3e3e3] bg-white px-4 py-4 shadow-[0px_1px_0px_0px_white] dark:border-[#313131] dark:bg-[#1a1a1a] dark:shadow-none",
        className,
      )}
    >
      {children}
    </div>
  );
};

export const WalletDialogFooter: React.FC<{
  primaryLabel: string;
  secondaryLabel?: string;
  onPrimaryClick: () => void;
  onSecondaryClick?: () => void;
  primaryDisabled?: boolean;
  secondaryDisabled?: boolean;
  primaryLoading?: boolean;
  primaryVariant?: "primary" | "primaryLight";
}> = ({
  primaryLabel,
  secondaryLabel = "Cancel",
  onPrimaryClick,
  onSecondaryClick,
  primaryDisabled,
  secondaryDisabled,
  primaryLoading,
  primaryVariant = "primary",
}) => {
  return (
    <div className="flex gap-4">
      {onSecondaryClick ? (
        <Button
          type="button"
          variant="defaultStable"
          className="h-[40px] flex-1 rounded-[6px] border border-[#e3e3e3] bg-[#fefefe] px-4 text-[13px] font-medium tracking-[-0.26px] text-[#4f4f4f] dark:border-[#494949] dark:bg-[#2a2a2a] dark:text-white"
          onClick={onSecondaryClick}
          disabled={secondaryDisabled}
        >
          {secondaryLabel}
        </Button>
      ) : null}
      <Button
        type="button"
        variant={primaryVariant}
        className="h-[40px] flex-1 rounded-[6px] px-4 text-[14px] font-medium tracking-[-0.28px]"
        onClick={onPrimaryClick}
        disabled={primaryDisabled || primaryLoading}
      >
        {primaryLoading ? "Processing..." : primaryLabel}
      </Button>
    </div>
  );
};
