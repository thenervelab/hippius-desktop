"use client";

import type { ReactNode } from "react";
import { useSetAtom } from "jotai";
import { ArrowLeft, X } from "lucide-react";

import { rightPanelAtom } from "@/components/chat/chat-ui-atoms";

interface PanelHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional back action (e.g. member profile → details). */
  onBack?: () => void;
}

/** Shared header of the right column: title, optional back, close. */
export default function PanelHeader({ title, subtitle, onBack }: PanelHeaderProps) {
  const setRightPanel = useSetAtom(rightPanelAtom);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-grey-80 px-3 dark:border-black-300">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="inline-flex size-7 items-center justify-center rounded-md text-grey-60 hover:bg-grey-90 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold text-grey-10 dark:text-grey-light-100">{title}</h2>
        {subtitle ? <p className="truncate text-xs text-grey-60 dark:text-grey-dark-700">{subtitle}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => setRightPanel(null)}
        aria-label="Close panel"
        className="inline-flex size-7 items-center justify-center rounded-md text-grey-60 hover:bg-grey-90 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100"
      >
        <X className="size-4" aria-hidden />
      </button>
    </header>
  );
}
