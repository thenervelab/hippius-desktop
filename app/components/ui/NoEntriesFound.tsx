import { cn } from "@/lib/utils";
import { useState, useCallback, DragEvent, MouseEvent } from "react";
import { NoEntriesBackgroundContainer } from "@/components/ui/NoEntriesBackgroundContainer";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2, Upload, X } from "lucide-react";
import {
  NoEntriesIllustration,
  NoEntriesIllustrationDark,
  NoCreditsIllustration,
  NoCreditsIllustrationDark,
} from "@/components/ui/icons";
import CreateButton from "./button/CreateButton";
import Button from "./button";

export type NoEntriesVariant = "default" | "noCredits";

interface NoEntriesFoundProps {
  /** Main heading text */
  title?: string;
  /** Subtitle / description text */
  description?: string;
  /** Description shown while files are being dragged over */
  dragDescription?: string;
  /** Primary CTA button label – footer is hidden when both button labels are omitted */
  buttonText?: string;
  /** Optional element rendered left of the primary CTA label (e.g. a Plus icon). */
  buttonIcon?: React.ReactNode;
  /** Callback fired when the primary CTA button is clicked */
  onButtonClick?: () => void;
  /** Secondary CTA button label – appears to the left of the primary button */
  secondaryButtonText?: string;
  /** Optional element rendered left of the secondary CTA label (e.g. an upload icon). */
  secondaryButtonIcon?: React.ReactNode;
  /** Callback fired when the secondary CTA button is clicked */
  onSecondaryButtonClick?: () => void;
  /** Optional close (X) handler – shows a compact close button in the header when provided */
  onClose?: () => void;
  /** Callback fired when files are dropped – enables drag-and-drop when provided */
  onFileDrop?: (files: FileList) => void;
  /** Shows a spinner on the primary CTA button */
  isLoading?: boolean;
  /** Shows a spinner on the secondary CTA button */
  isSecondaryLoading?: boolean;
  /** Disables the primary CTA button and shows a tooltip */
  disabled?: boolean;
  /** Tooltip message when the primary button is disabled */
  disabledMessage?: string;
  /** Hides the default illustration in the header (legacy / compact layouts) */
  hideIllustration?: boolean;
  /** Adds card-view specific border styles */
  cardView?: boolean;
  className?: string;
  /** When true, stretches to fill parent height with header/footer spaced apart */
  fillHeight?: boolean;
  containerClassName?: string;
  /** When provided, replaces the entire default header content block (illustration + texts) */
  children?: React.ReactNode;
  /**
   * Visual variant.
   * - `"default"`: standard empty-state look.
   * - `"noCredits"`: swaps the illustration to the no-credit graphic and
   *   paints the primary CTA in `warning-200` (used when a gated action
   *   is blocked because the user has insufficient credits).
   */
  variant?: NoEntriesVariant;
}

const NoEntriesFound = ({
  title = "No entries yet",
  description = "Get started by creating your first entry.",
  dragDescription = "Drop files here to upload",
  buttonText,
  buttonIcon,
  onButtonClick,
  secondaryButtonText,
  secondaryButtonIcon,
  onSecondaryButtonClick,
  onClose,
  onFileDrop,
  isLoading = false,
  isSecondaryLoading = false,
  disabled = false,
  disabledMessage = "Coming Soon",
  hideIllustration = false,
  cardView = true,
  className,
  fillHeight = false,
  containerClassName,
  children,
  variant = "default",
}: NoEntriesFoundProps) => {
  const isNoCredits = variant === "noCredits";
  const LightIllustration = isNoCredits
    ? NoCreditsIllustration
    : NoEntriesIllustration;
  const DarkIllustration = isNoCredits
    ? NoCreditsIllustrationDark
    : NoEntriesIllustrationDark;
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const targetFiles = e.dataTransfer.files;
      if (targetFiles && targetFiles.length > 0 && onFileDrop) {
        onFileDrop(targetFiles);
      }
    },
    [onFileDrop],
  );

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (onFileDrop) setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handlePrimaryClick = useCallback(
    (e?: MouseEvent<HTMLButtonElement>) => {
      e?.preventDefault();
      e?.stopPropagation();
      onButtonClick?.();
    },
    [onButtonClick],
  );

  const handleSecondaryClick = useCallback(
    (e?: MouseEvent<HTMLButtonElement>) => {
      e?.preventDefault();
      e?.stopPropagation();
      onSecondaryButtonClick?.();
    },
    [onSecondaryButtonClick],
  );

  const hasFooter = !!buttonText || !!secondaryButtonText;

  return (
    <div
      className={cn(
        "w-full  flex justify-center transition-all duration-200 overflow-hidden bg-grey-light-600 dark:bg-black-primary-bg p-8 sm:p-14 2xl:p-20 ",
        fillHeight ? "items-stretch" : "items-center",
        isDragging && "bg-gray-50/50 dark:bg-gray-900/50",
        cardView &&
          "border border-grey-dark-100 rounded-lg dark:border-black-300 ",
        className,
      )}
      onDrop={onFileDrop ? handleDrop : undefined}
      onDragOver={onFileDrop ? handleDragOver : undefined}
      onDragLeave={onFileDrop ? handleDragLeave : undefined}
    >
      <NoEntriesBackgroundContainer
        className={containerClassName}
        fillHeight={fillHeight}
      >
        {/* Header */}
        <div
          className={cn(
            "bg-white px-3 sm:px-5 py-4 dark:bg-[#161616]",
            hasFooter ? "rounded-t-[12px]" : "rounded-[12px]",
          )}
        >
          {children ? (
            children
          ) : (
            <div className="flex gap-5 items-center">
              {!hideIllustration && (
                <div className="shrink-0">
                  <LightIllustration className="block dark:hidden" />
                  <DarkIllustration className="hidden dark:block" />
                </div>
              )}
              <div className="flex-1 min-w-0 flex flex-col gap-[6px]">
                <div className="flex items-start gap-5 w-full">
                  <h3 className="flex-1 text-[18px] font-medium leading-6 tracking-[-0.54px] text-[#171717] dark:text-white">
                    {title}
                  </h3>
                  {onClose && (
                    <button
                      type="button"
                      onClick={onClose}
                      aria-label="Dismiss"
                      className="shrink-0 flex items-center justify-center rounded-full p-[2px] text-[#171717] dark:text-white opacity-70 hover:opacity-100 transition-opacity"
                    >
                      <X className="size-5" />
                    </button>
                  )}
                </div>
                <p className="text-[16px] font-medium leading-6 tracking-[-0.48px] text-[#52525c] dark:text-white dark:opacity-50">
                  {isDragging ? dragDescription : description}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {hasFooter && (
          <div className="bg-white border-t border-[#ebebeb] px-3 sm:px-5 py-[14px] rounded-b-[12px] dark:bg-[#161616] dark:border-[#313131] flex gap-4 items-center justify-end">
            {secondaryButtonText && (
              <Button
                type="button"
                variant="defaultStable"
                size="auto"
                onClick={handleSecondaryClick}
                disabled={isSecondaryLoading}
                // The card body sits on bg-grey-light-600, which is the
                // same tone as defaultStable's bg-grey-90 — the button
                // would vanish without an explicit surface. White + a
                // neutral border restores contrast while keeping the
                // secondary read; the !-overrides win over the variant's
                // baked-in bg/hover so the chip stays legible in both
                // themes and picks up the variant's hover/active animations.
                className={cn(
                  "flex-1 h-9 rounded-[10px] gap-1 px-3 py-2",
                  "text-[14px] font-medium tracking-[-0.28px]",
                  "!bg-white !text-[#5c5c5c] border border-[#ebebeb] shadow-[0px_1px_2px_0px_rgba(10,13,20,0.03)] hover:!bg-grey-light-700",
                  "dark:!bg-[rgba(255,255,255,0.03)] dark:!text-white dark:border-[#313131] dark:hover:!bg-[#2c2c2c]",
                )}
              >
                {isSecondaryLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <span className="flex items-center gap-2 px-1">
                    {secondaryButtonIcon}
                    <span>{secondaryButtonText}</span>
                  </span>
                )}
              </Button>
            )}
            {buttonText &&
              (disabled ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        disabled
                        className="flex-1 h-9 rounded-[10px] flex items-center justify-center gap-1.5 bg-grey-90 border border-grey-80 text-grey-50 cursor-not-allowed text-sm font-medium"
                      >
                        <Upload className="size-4" />
                        <span>{buttonText}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{disabledMessage}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : isNoCredits ? (
                // Plain button instead of CreateButton — CreateButton is
                // pinned to variant="primary" (bg-primary-50) and the
                // tailwind-merge pass collapses the override, so we
                // bypass the variant indirection and write the warning
                // colour directly.

                <Button
                  variant="warning"
                  size="auto"
                  onClick={handlePrimaryClick}
                  disabled={isLoading}
                  className={cn(
                    "h-[30px] px-3 py-[10px] gap-[10px] rounded-[6px]",
                    "font-geist  leading-[1.109] flex-1 h-9 rounded-[10px] px-3 text-[14px] font-medium tracking-[-0.28px]",
                  )}
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <span>{buttonText}</span>
                  )}
                </Button>
              ) : (
                <CreateButton
                  text={buttonText}
                  isLoading={isLoading}
                  onClick={handlePrimaryClick}
                  icon={buttonIcon}
                  className="flex-1 h-9 rounded-[10px] px-3 text-[14px] font-medium tracking-[-0.28px]"
                />
              ))}
          </div>
        )}
      </NoEntriesBackgroundContainer>
    </div>
  );
};

export default NoEntriesFound;
