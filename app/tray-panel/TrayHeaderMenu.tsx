"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppWindow, ChevronRight, FolderOpen, LifeBuoy, MoreVertical, Power, Settings } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CONTENT_CLASSES, ITEM_CLASSES, SEPARATOR_CLASSES } from "@/app/components/capture/CaptureButtons";
import type { StorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { formatBalanceUsd } from "@/app/lib/utils/formatBalanceUsd";
import { isMacPlatform } from "@/app/lib/utils/isMacPlatform";
import {
  trayMenuShortcutFor,
  trayPlanLine,
  trayShortcutLabel,
  type TrayMenuShortcut,
} from "@/app/lib/tray/trayHeaderMenu";
import { openCapturesFolder, openMainPage, openMainWindow, quitFromTray } from "./trayMainWindow";

export const OPEN_HIPPIUS_LABEL = "Open Hippius";
export const CAPTURES_FOLDER_LABEL = "Open captures folder";
export const SETTINGS_LABEL = "Settings";
export const HELP_LABEL = "Help & Support";
export const QUIT_LABEL = "Quit Hippius";

/** The header's own button look (the bell's), so ⋮ reads as one of them. */
const TRIGGER =
  "relative flex h-9 w-9 items-center justify-center rounded-lg text-grey-10 outline-none transition-colors hover:bg-[rgba(0,0,0,0.05)] focus-visible:ring-2 focus-visible:ring-primary-50 data-[state=open]:bg-[rgba(0,0,0,0.06)] dark:text-white dark:hover:bg-white/10 dark:focus-visible:ring-primary-brand-dark dark:data-[state=open]:bg-white/10";
const ROW_LABEL =
  "font-mono text-[10px] font-medium uppercase leading-[14px] tracking-[-0.2px] text-[#1F51BE] dark:text-primary-brand-dark";
const ROW_VALUE = "truncate font-geist text-[14px] font-medium leading-5 tracking-[-0.28px] text-grey-10 dark:text-white";
const SHORTCUT = "ml-auto shrink-0 pl-4 font-geist text-[12px] font-medium tracking-normal text-grey-60 dark:text-grey-dark-600";

/** What the keys do: the same as the items. */
const RUN: Record<TrayMenuShortcut, () => Promise<void>> = {
  open: openMainWindow,
  settings: () => openMainPage("settings"),
  quit: quitFromTray,
};

/** The plan row when the plan could not be read. */
export const PLAN_UNAVAILABLE = "Couldn't load your plan";

/**
 * The ⋮ menu at the header's right end, beside the balance and the bell
 * (which stay where they are): the balance with Top up, the plan, then
 * Open Hippius, the captures folder, Settings and Help & Support, then
 * Quit. Everything that opens a page asks the main window
 * (`openMainPage`); the popover never navigates.
 *
 * ⌘O, ⌘, and ⌘Q (Ctrl on Windows and Linux) work while the popover has the
 * keyboard, menu open or not. They are not global shortcuts: they belong
 * to this window only.
 */
export default function TrayHeaderMenu({
  balance,
  accountId,
  showCapturesFolder,
}: {
  /** The billing API's exact decimal string; null while unknown. */
  balance: string | null;
  /** The signed-in account, once its session is ready; null before. */
  accountId: string | null;
  /** Capture is offered here, so there is a captures folder to open. */
  showCapturesFolder: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  // The last read failed and nothing has loaded since: say so rather than
  // leave the row loading for ever.
  const [planFailed, setPlanFailed] = useState(false);
  // Read when used, never during the static export's prerender.
  const mac = isMacPlatform();

  // The plan, from the same Rust answer as the Plans page and the header
  // chip. Asked on every open (the popover is long-lived and prewarmed);
  // the last answer stays on screen meanwhile. The command is account
  // scoped, so it waits for the session (`accountId`); asked without one,
  // Rust refuses it and the row never loaded.
  useEffect(() => {
    if (!open || !accountId) return;
    let live = true;
    invoke<StorageOverview>("get_storage_overview", { accountId })
      .then((next) => {
        if (!live) return;
        setOverview(next);
        setPlanFailed(false);
      })
      .catch((error) => {
        console.error("[TrayPanel] storage overview failed:", error);
        if (live) setPlanFailed(true);
      });
    return () => {
      live = false;
    };
  }, [open, accountId]);

  // The popover hides on a click outside it (a window blur), which Radix
  // never hears: close the menu with it, so the next open is not stuck open.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [open]);

  // The items' keys, while this window has the keyboard.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const id = trayMenuShortcutFor(event, isMacPlatform());
      if (!id) return;
      event.preventDefault();
      setOpen(false);
      void RUN[id]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const balanceText = balance === null ? "…" : formatBalanceUsd(balance);
  const planText = trayPlanLine(overview) ?? (planFailed ? PLAN_UNAVAILABLE : null);
  const select = useCallback((run: () => Promise<void>) => {
    setOpen(false);
    void run();
  }, []);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="More" title="More" className={TRIGGER}>
          <MoreVertical aria-hidden className="size-4 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      {/* Named by its trigger ("More"), which Radix links. */}
      <DropdownMenuContent align="end" sideOffset={8} className={cn(CONTENT_CLASSES, "w-[17.5rem]")}>
        <DropdownMenuItem
          className={cn(ITEM_CLASSES, "gap-3 py-2")}
          aria-label={`Top up. Balance ${balanceText}`}
          onSelect={() => select(() => openMainPage("top-up"))}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={ROW_LABEL}>Balance</span>
            <span data-testid="tray-menu-balance" className={ROW_VALUE}>
              {balanceText}
            </span>
          </span>
          <span className="shrink-0 rounded-md bg-primary-50 px-2.5 py-1 font-geist text-[12px] font-semibold leading-4 text-white">
            Top up
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn(ITEM_CLASSES, "gap-3 py-2")}
          aria-label={`Plan: ${planText ?? "loading"}. Open Subscription Plans`}
          onSelect={() => select(() => openMainPage("plans"))}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={ROW_LABEL}>Plan</span>
            {planText ? (
              <span data-testid="tray-menu-plan" className={ROW_VALUE}>
                {planText}
              </span>
            ) : (
              <span aria-hidden className="my-0.5 h-4 w-32 animate-pulse rounded bg-[rgba(0,0,0,0.08)] dark:bg-white/10" />
            )}
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0 opacity-50" />
        </DropdownMenuItem>
        <DropdownMenuSeparator className={SEPARATOR_CLASSES} />
        <Item icon={<AppWindow aria-hidden className="size-4 shrink-0" />} shortcut={trayShortcutLabel("open", mac)} onSelect={() => select(openMainWindow)}>
          {OPEN_HIPPIUS_LABEL}
        </Item>
        {showCapturesFolder && (
          <Item icon={<FolderOpen aria-hidden className="size-4 shrink-0" />} onSelect={() => select(openCapturesFolder)}>
            {CAPTURES_FOLDER_LABEL}
          </Item>
        )}
        <Item
          icon={<Settings aria-hidden className="size-4 shrink-0" />}
          shortcut={trayShortcutLabel("settings", mac)}
          onSelect={() => select(() => openMainPage("settings"))}
        >
          {SETTINGS_LABEL}
        </Item>
        <Item icon={<LifeBuoy aria-hidden className="size-4 shrink-0" />} onSelect={() => select(() => openMainPage("support"))}>
          {HELP_LABEL}
        </Item>
        <DropdownMenuSeparator className={SEPARATOR_CLASSES} />
        <Item icon={<Power aria-hidden className="size-4 shrink-0" />} shortcut={trayShortcutLabel("quit", mac)} onSelect={() => select(quitFromTray)}>
          {QUIT_LABEL}
        </Item>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One plain item: icon, words, and its keys at the right in muted text. */
function Item({
  icon,
  shortcut,
  onSelect,
  children,
}: {
  icon: ReactNode;
  shortcut?: string;
  onSelect: () => void;
  children: string;
}) {
  return (
    <DropdownMenuItem
      className={ITEM_CLASSES}
      aria-keyshortcuts={shortcut ? ariaKeys(shortcut) : undefined}
      onSelect={onSelect}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && (
        <span aria-hidden className={SHORTCUT}>
          {shortcut}
        </span>
      )}
    </DropdownMenuItem>
  );
}

/** "⌘O" → "Meta+O", "Ctrl+," → "Control+," for `aria-keyshortcuts`. */
function ariaKeys(label: string): string {
  return label.startsWith("⌘") ? `Meta+${label.slice(1)}` : label.replace(/^Ctrl\+/, "Control+");
}
