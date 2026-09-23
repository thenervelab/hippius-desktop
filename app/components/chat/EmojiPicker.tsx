"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Search } from "lucide-react";

import { chatMenuContentClassName } from "@/components/chat/ChatMenu";
import { EMOJI, EMOJI_GROUPS, type Emoji, type EmojiGroup, QUICK_REACTIONS, searchEmoji } from "@/lib/chat/emoji";
import { cn } from "@/lib/utils";

const RECENT_KEY = "hippius.chat.recentEmoji";
const RECENT_MAX = 16;
const COLUMNS = 8;

export function recentEmoji(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(char: string): void {
  try {
    const next = [char, ...recentEmoji().filter((c) => c !== char)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: recents are a nicety
  }
}

interface EmojiPickerProps {
  trigger: ReactNode;
  onPick: (char: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Show the quick-reaction row on top (reactions) or not (composer). */
  quickRow?: boolean;
  align?: "start" | "end" | "center";
  side?: "top" | "bottom";
}

/**
 * Emoji picker: search field, group tabs, 8-column grid with arrow-key
 * navigation. Built on Radix DropdownMenu for positioning and dismissal
 * (no Popover primitive in the tree), with the grid handling its own keys.
 */
export default function EmojiPicker({ trigger, onPick, open, onOpenChange, quickRow = true, align = "end", side = "top" }: EmojiPickerProps) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<EmojiGroup | "recent">("smileys");
  const [active, setActive] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const recents = useMemo(() => (typeof window === "undefined" ? [] : recentEmoji()), []);

  const list: Emoji[] = useMemo(() => {
    if (query.trim()) return searchEmoji(query, 64);
    if (group === "recent") {
      return recents.map((char) => EMOJI.find((e) => e.char === char) ?? { char, name: char, keywords: [], group: "symbols" as const });
    }
    return EMOJI.filter((e) => e.group === group);
  }, [query, group, recents]);

  useEffect(() => setActive(0), [query, group]);

  const pick = (char: string) => {
    rememberEmoji(char);
    onPick(char);
    onOpenChange?.(false);
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const max = list.length - 1;
    let next = active;
    if (event.key === "ArrowRight") next = Math.min(max, active + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, active - 1);
    else if (event.key === "ArrowDown") next = Math.min(max, active + COLUMNS);
    else if (event.key === "ArrowUp") next = Math.max(0, active - COLUMNS);
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (list[active]) pick(list[active].char);
      return;
    } else return;
    event.preventDefault();
    setActive(next);
    const el = gridRef.current?.children[next] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  };

  const tabClass = (selected: boolean) =>
    cn(
      "rounded px-1.5 py-0.5 text-[11px] transition-colors",
      selected
        ? "bg-primary-50 text-white dark:bg-primary-40 dark:text-white"
        : "text-grey-60 hover:bg-grey-90 hover:text-grey-10 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100",
    );

  return (
    <Dropdown.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align={align}
          side={side}
          sideOffset={6}
          className={cn(chatMenuContentClassName, "w-[320px] p-2")}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Radix menus steal typeahead keys; we own the keyboard inside.
          onKeyDown={(e) => e.stopPropagation()}
        >
          {quickRow ? (
            <div className="mb-2 flex justify-between px-0.5" role="group" aria-label="Quick reactions">
              {QUICK_REACTIONS.map((char) => (
                <button
                  key={char}
                  type="button"
                  onClick={() => pick(char)}
                  className="rounded-md p-1 text-xl leading-none hover:bg-grey-90 dark:hover:bg-black-500"
                  aria-label={`React with ${char}`}
                >
                  {char}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mb-2 flex h-8 items-center gap-1.5 rounded-md border border-grey-80 bg-grey-light-600 px-2 dark:border-black-300 dark:bg-black-primary-bg">
            <Search className="size-3.5 shrink-0 text-grey-60 dark:text-grey-dark-700" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  gridRef.current?.focus();
                }
              }}
              placeholder="Search emoji"
              aria-label="Search emoji"
              className="min-w-0 flex-1 bg-transparent text-xs text-grey-10 outline-none placeholder:text-grey-60 dark:text-grey-light-100 dark:placeholder:text-grey-dark-700"
            />
          </div>
          {!query.trim() ? (
            <div className="mb-1.5 flex flex-wrap gap-0.5" role="tablist" aria-label="Emoji groups">
              {recents.length ? (
                <button type="button" role="tab" aria-selected={group === "recent"} className={tabClass(group === "recent")} onClick={() => setGroup("recent")}>
                  Recent
                </button>
              ) : null}
              {EMOJI_GROUPS.map((g) => (
                <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className={tabClass(group === g.id)} onClick={() => setGroup(g.id)}>
                  {g.label}
                </button>
              ))}
            </div>
          ) : null}
          <div
            ref={gridRef}
            role="listbox"
            aria-label="Emoji"
            tabIndex={0}
            onKeyDown={onGridKey}
            className="grid max-h-[220px] grid-cols-8 gap-0.5 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-primary-50 dark:focus-visible:ring-primary-40"
          >
            {list.length === 0 ? (
              <p className="col-span-8 py-6 text-center text-xs text-grey-60 dark:text-grey-dark-700">No emoji match</p>
            ) : (
              list.map((item, index) => (
                <button
                  key={`${item.char}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  aria-label={item.name}
                  title={`:${item.name}:`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(item.char)}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-md text-xl leading-none",
                    index === active ? "bg-grey-90 dark:bg-black-500" : "hover:bg-grey-90 dark:hover:bg-black-500",
                  )}
                >
                  {item.char}
                </button>
              ))
            )}
          </div>
          {list[active] ? (
            <p className="mt-1.5 truncate px-0.5 text-[11px] text-grey-60 dark:text-grey-dark-700">
              <span className="mr-1">{list[active].char}</span>:{list[active].name}:
            </p>
          ) : null}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
