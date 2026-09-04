"use client";

import React, { type ReactNode, useEffect, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { BackgroundContainer } from "@/components/ui/BackgroundContainer";
import { Decoration } from "@/components/ui/icons";

export interface FramedDialogProps {
  open: boolean;
  onClose: () => void;
  /** A node, not a string, so a heading can carry a muted lead line. */
  title: ReactNode;
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
  /**
   * When true the dialog becomes a blocking gate: the close (X) button
   * is hidden and Escape / click-outside no longer dismiss it. Used by
   * flows the user must complete (e.g. the post-login recovery gate).
   * `onClose` is never called while this is set.
   */
  preventClose?: boolean;
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
  preventClose = false,
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
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !preventClose) onClose();
      }}
    >
      <Dialog.Portal>
        {/* Backdrop */}
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-white/70 backdrop-blur-[5.75px] dark:bg-black-850/40 dark:backdrop-blur-[11.5px]" />

        {/* Full-screen positioner — click outside closes unless this is a
            blocking gate (`preventClose`). The Escape / pointer-outside
            handlers are also suppressed so Radix's own dismissal can't
            fire either. */}
        <Dialog.Content
          ref={contentRef}
          aria-describedby={undefined}
          className="fixed top-0 left-0 right-0 h-screen z-[61] flex items-center justify-center p-3 sm:p-6"
          onClick={preventClose ? undefined : onClose}
          onEscapeKeyDown={preventClose ? (e) => e.preventDefault() : undefined}
          onPointerDownOutside={
            preventClose ? (e) => e.preventDefault() : undefined
          }
          onInteractOutside={
            preventClose ? (e) => e.preventDefault() : undefined
          }
        >
          <BackgroundContainer
            className={cn("w-full", maxWidth)}
            fillClassName="fill-[#f9f9f9] dark:fill-[#262626]"
            hippoIconClassName="fill-[#989898] dark:fill-[#5e5e5e]"
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

              {/* Close button — anchored to card top-right, outside scroll
                  area. Omitted for blocking gates (`preventClose`). */}
              {!preventClose && (
                <Dialog.Close asChild>
                  <button
                    aria-label="Close"
                    className="absolute right-4 top-4 z-20 text-[#0a0a0a] hover:text-[#737373] dark:text-white dark:hover:text-[#a3a3a3] transition-colors"
                  >
                    <X className="size-5" />
                  </button>
                </Dialog.Close>
              )}

              {/* Scrollable inner area */}
              <div
                className={cn(
                  "mx-auto w-full max-h-[85vh] overflow-y-auto px-4 pb-5 pt-4",
                  "sm:max-h-[calc(100vh-200px)] sm:px-5",
                  contentClassName,
                )}
              >
                {/* Icon badge sits on top of the shared Decoration grid.
                    Decoration handles both modes — radial white-fade in
                    light, Gaussian-blurred ellipse mask in dark — so we
                    don't need separate WebGL / CSS-grid backgrounds and
                    every dialog (stake, unstake, confirm, withdraw,
                    settings…) gets the same hippius-web-style grid. */}
                <div className="relative mx-auto mb-3 flex size-12 shrink-0 items-center justify-center sm:size-14">
                  <Decoration
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 size-full"
                  />
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
