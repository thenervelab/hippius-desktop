"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export const chatMenuContentClassName =
  "z-50 min-w-[200px] overflow-hidden rounded-lg border border-grey-80 bg-white p-1 shadow-dialog dark:border-black-300 dark:bg-black-300";

export const chatMenuItemClassName =
  "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-grey-10 outline-none data-[highlighted]:bg-grey-90 dark:text-grey-light-100 dark:data-[highlighted]:bg-black-500 data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

export const chatMenuDestructiveItemClassName =
  "text-error-50 data-[highlighted]:bg-error-50/10 dark:text-error-50 dark:data-[highlighted]:bg-error-50/20";

export interface ChatMenuItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface ChatMenuProps extends Pick<ComponentPropsWithoutRef<typeof Dropdown.Content>, "align" | "side"> {
  trigger: ReactNode;
  items: readonly (ChatMenuItem | "separator")[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  label?: string;
}

/** Radix dropdown menu in the console's palette; trigger is any element. */
export default function ChatMenu({ trigger, items, open, onOpenChange, align = "end", side = "bottom", label }: ChatMenuProps) {
  return (
    <Dropdown.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align={align} side={side} sideOffset={4} className={chatMenuContentClassName} aria-label={label}>
          {label ? (
            <Dropdown.Label className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-grey-60 dark:text-grey-dark-700">
              {label}
            </Dropdown.Label>
          ) : null}
          {items.map((item, index) =>
            item === "separator" ? (
              <Dropdown.Separator key={`sep-${index}`} className="my-1 h-px bg-grey-80 dark:bg-black-500" />
            ) : (
              <Dropdown.Item
                key={item.key}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn(chatMenuItemClassName, item.destructive && chatMenuDestructiveItemClassName)}
              >
                {item.icon ? <item.icon className="size-4 shrink-0" aria-hidden /> : null}
                <span className="flex-1">{item.label}</span>
                {item.shortcut ? <kbd className="text-[10px] text-grey-60 dark:text-grey-dark-700">{item.shortcut}</kbd> : null}
              </Dropdown.Item>
            ),
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
