"use client";

import React, { type ReactNode, useEffect, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import GraphSheetContainer from "@/components/ui/graphsheet";
import { BackgroundContainer } from "@/components/ui/BackgroundContainer";

export interface FramedDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  icon: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  cardClassName?: string;
  titleClassName?: string;
  maxWidth?: string;
  borderClassName?: string;
  iconBgClassName?: string;
  /**
   * Optional content rendered above the icon (e.g. a multi-step
   * indicator). Sits inside the scrollable area, below the close
   * button row.
   */
  stepIndicator?: ReactNode;
}

export function FramedDialog({
  open,
  onClose,
  title,
  icon,
  children,
  contentClassName,
  cardClassName,
  titleClassName,
  maxWidth = "max-w-[560px]",
  borderClassName,
  iconBgClassName = "bg-[#3167dd]",
  stepIndicator,
}: FramedDialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const el = contentRef.current;
      if (!el) return;
      el.style.height = `${vv.height}px`;
      el.style.top = `${vv.offsetTop}px`;
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        {/* Backdrop */}
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-white/70 backdrop-blur-[5.75px] dark:bg-[rgba(4, 4, 4, 0.4)] dark:backdrop-blur-[11.5px]" />

        {/* Full-screen positioner — click outside closes */}
        <Dialog.Content
          ref={contentRef}
          aria-describedby={undefined}
          className="fixed top-0 left-0 right-0 h-screen z-[61] flex items-center justify-center p-3 sm:p-6"
          onClick={onClose}
        >
          <BackgroundContainer
            className={cn("w-full", maxWidth)}
            fillClassName="fill-[#f9f9f9] dark:fill-[#202020]"
            strokeClassName="stroke-[#b3b3b3] dark:stroke-[#6c6c6c]"
            borderClassName={borderClassName}
            contentClassName="flex justify-center"
            shellClassName={cn("w-full min-w-0", maxWidth)}
            cardClassName={cn(
              "w-full min-w-0 max-w-full gap-0 p-0",
              cardClassName,
            )}
            stopClickPropagation
            addDotWithBlurryEffect
            isDialog
          >
            {/* Card wrapper — relative so close button anchors to the card corner */}
            <div className="relative w-full">
              {/* Optional step indicator — anchored to card top-left */}
              {stepIndicator && (
                <div className="absolute left-4 top-4 z-20 sm:left-5">
                  {stepIndicator}
                </div>
              )}

              {/* Close button — anchored to card top-right, outside scroll area */}
              <Dialog.Close asChild>
                <button
                  aria-label="Close"
                  className="absolute right-4 top-4 z-20 text-[#0a0a0a] hover:text-[#737373] dark:text-white dark:hover:text-[#a3a3a3] transition-colors"
                >
                  <X className="size-5" />
                </button>
              </Dialog.Close>

              {/* Scrollable inner area */}
              <div
                className={cn(
                  "mx-auto w-full max-h-[85vh] overflow-y-auto px-4 pb-5 pt-4",
                  "sm:max-h-[calc(100vh-200px)] sm:px-5",
                  contentClassName,
                )}
              >
                {/* Icon badge with WebGL grid background */}
                <div className="relative flex size-12 sm:size-14 items-center justify-center overflow-hidden rounded-[4px] dark:rounded-full mx-auto mb-3">
                  {/* Light mode: WebGL canvas grid */}
                  <GraphSheetContainer
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
                    className="absolute inset-0 size-full opacity-30 dark:hidden"
                  />

                  {/* Dark mode: CSS grid with radial fade mask */}
                  <div
                    className="absolute inset-0 size-full hidden dark:block"
                    style={{
                      backgroundImage:
                        "linear-gradient(to right, rgba(31,80,189,0.85) 1px, transparent 1px), linear-gradient(to bottom, rgba(31,80,189,0.85) 1px, transparent 1px)",
                      backgroundSize: "17px 17px",
                      maskImage:
                        "radial-gradient(55% 70% at 50% 50%, black 0%, transparent 100%)",
                      WebkitMaskImage:
                        "radial-gradient(55% 70% at 50% 50%, black 0%, transparent 100%)",
                    }}
                  />

                  {/* Light mode gradient wash */}
                  <div className="bg-gradient-to-b from-white/80 via-white/40 to-transparent absolute inset-0 dark:hidden" />

                  {/* Icon container */}
                  <div
                    className={cn(
                      "relative flex size-8 items-center justify-center rounded-lg",
                      iconBgClassName,
                    )}
                  >
                    {icon}
                  </div>
                </div>

                {/* Title */}
                <Dialog.Title
                  className={cn(
                    "mb-2 text-center text-[22px] font-semibold leading-tight text-[#0a0a0a] dark:text-white",
                    "sm:text-[28px] sm:leading-9",
                    titleClassName,
                  )}
                >
                  {title}
                </Dialog.Title>

                {/* Body */}
                {children}
              </div>
            </div>
          </BackgroundContainer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default FramedDialog;
