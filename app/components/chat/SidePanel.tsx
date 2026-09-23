"use client";

import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

interface SidePanelProps {
  side: "left" | "right";
  open: boolean;
  onClose: () => void;
  /** Accessible title for the sheet (visually hidden). */
  title: string;
  children: ReactNode;
}

/**
 * Slide-in sheet for small screens: the sidebar from the left, the details
 * or thread panel from the right. Radix Dialog gives focus trapping, Esc
 * and overlay dismissal; the content is whatever the desktop column shows.
 *
 * Mount it only below the breakpoint where the column is inline. Hiding it
 * with CSS is not enough: an open dialog still traps focus and hides the
 * page from assistive technology.
 */
export default function SidePanel({ side, open, onClose, title, children }: SidePanelProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <Dialog.Portal>
        <div>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black-900/40 backdrop-blur-[2px] dark:bg-black-900/60 data-[state=open]:animate-fade-in-0.3" />
          <Dialog.Content
            aria-describedby={undefined}
            className={cn(
              "fixed inset-y-0 z-50 flex w-[min(360px,90vw)] flex-col bg-white shadow-dialog outline-none data-[state=open]:animate-fade-in-0.3 dark:bg-black-300",
              side === "left" ? "left-0 border-r border-grey-80 dark:border-black-300" : "right-0 border-l border-grey-80 dark:border-black-300",
            )}
          >
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className={cn(
                  "absolute top-2 z-10 inline-flex size-8 items-center justify-center rounded-md text-grey-60 hover:bg-grey-90 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100",
                  side === "left" ? "right-2" : "right-2",
                )}
              >
                <X className="size-4" aria-hidden />
              </button>
            </Dialog.Close>
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
