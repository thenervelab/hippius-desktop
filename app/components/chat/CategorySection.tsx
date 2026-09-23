"use client";

import type { ReactNode } from "react";
import { ChevronDown, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

interface CategorySectionProps {
  id: string;
  name: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Mentions and unread messages in the category, shown on the header when it is folded. */
  highlight: number;
  unread: number;
  /** Admins only: "New channel" preselecting this category. */
  onAdd?: () => void;
  children: ReactNode;
}

/**
 * A channel category inside the Channels section: a folding header, its
 * channels underneath. Folding hides the rows; what they held in unread
 * moves onto the header (red for a mention, a dot for plain unread) so a
 * folded category never hides that something happened.
 */
export default function CategorySection({ id, name, collapsed, onToggle, highlight, unread, onAdd, children }: CategorySectionProps) {
  const contentId = `chat-category-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;

  return (
    <div role="group" aria-labelledby={`${contentId}-label`} className="mt-1" data-category-id={id}>
      <div className="group flex h-7 items-center gap-1 pr-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-left text-[11px] font-semibold uppercase tracking-wide text-grey-60 outline-none hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-grey-dark-700 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
        >
          <ChevronDown className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")} aria-hidden />
          <span id={`${contentId}-label`} className="truncate" title={name}>
            {name}
          </span>
          {collapsed && highlight > 0 ? (
            <span
              aria-label={`${highlight} mentions`}
              className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-error-50 px-1 text-[10px] font-semibold text-white dark:bg-error-40"
            >
              {highlight > 99 ? "99+" : highlight}
            </span>
          ) : collapsed && unread > 0 ? (
            <span aria-label={`${unread} unread`} className="ml-1 inline-block size-1.5 shrink-0 rounded-full bg-grey-30 dark:bg-grey-light-100" />
          ) : null}
        </button>
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            aria-label={`New channel in ${name}`}
            className="inline-flex size-6 items-center justify-center rounded text-grey-60 opacity-0 outline-none transition-opacity hover:bg-grey-90 hover:text-grey-10 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary-50 group-hover:opacity-100 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100 dark:focus-visible:ring-primary-40"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      <div id={contentId} hidden={collapsed} className="flex flex-col gap-px">
        {children}
      </div>
    </div>
  );
}
