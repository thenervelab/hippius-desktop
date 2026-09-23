"use client";

import { type ReactNode, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

interface SidebarSectionProps {
  id: string;
  title: string;
  /** Rendered after the title when collapsed, e.g. an unread count. */
  collapsedBadge?: number;
  onAdd?: () => void;
  addLabel?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Collapsible sidebar group ("Channels", "Direct messages", "Threads").
 * Collapsing hides read rooms only when there is nothing unread; the badge
 * on the header keeps unread counts visible either way.
 */
export default function SidebarSection({
  id,
  title,
  collapsedBadge = 0,
  onAdd,
  addLabel,
  defaultOpen = true,
  children,
}: SidebarSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = `chat-section-${id}`;

  return (
    <section aria-labelledby={`${contentId}-label`} className="px-2">
      <div className="group flex h-7 items-center gap-1 pr-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={contentId}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-left text-xs font-semibold uppercase tracking-wide text-grey-60 outline-none hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-grey-dark-700 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
        >
          <ChevronDown
            className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
            aria-hidden
          />
          <span id={`${contentId}-label`} className="truncate">
            {title}
          </span>
          {!open && collapsedBadge > 0 ? (
            <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-error-50 px-1 text-[10px] font-semibold text-white dark:bg-error-40">
              {collapsedBadge > 99 ? "99+" : collapsedBadge}
            </span>
          ) : null}
        </button>
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            aria-label={addLabel ?? `Add to ${title}`}
            className="inline-flex size-6 items-center justify-center rounded text-grey-60 opacity-0 outline-none transition-opacity hover:bg-grey-90 hover:text-grey-10 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary-50 group-hover:opacity-100 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      <div id={contentId} hidden={!open} className="flex flex-col gap-px pb-2">
        {children}
      </div>
    </section>
  );
}
