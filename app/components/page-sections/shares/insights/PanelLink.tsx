"use client";

import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, Link2, Lock } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { SHARES_QUERY_KEY, useSharedFiles } from "@/app/lib/hooks/useSharedFiles";
import { useUnlockFlow } from "@/app/lib/hooks/useUnlockFlow";
import {
  COPY_FAILED,
  COPY_LINK,
  HIDE_LINK,
  LINK_COPIED,
  LINK_LOCKED_NOTE,
  LINK_NEEDS_PASSWORD,
  LINK_UNAVAILABLE_NOTE,
  SHOW_LINK,
  UNLOCK_TO_COPY,
  HIDDEN_DOTS,
  maskedLink,
  type PanelLink,
} from "./panelLinkMedia";
import { HAIRLINE, ICON_BUTTON, MUTED, SKELETON, STRONG, TEXT_LINK } from "./panelStyles";

const TIP = "z-[60] max-w-[240px] bg-grey-10 text-white dark:bg-white dark:text-grey-10";

/**
 * Whether Hippius is locked on this computer. When it unlocks, the share
 * listing is read again: Rust can then open the owner wraps of links made
 * elsewhere, and the panel's link becomes copyable without being reopened.
 */
export function useAppLocked(): boolean {
  const locked = useAtomValue(syncRequiresReauthAtom);
  const queryClient = useQueryClient();
  const was = useRef(locked);
  useEffect(() => {
    if (was.current && !locked) void queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY] });
    was.current = locked;
  }, [locked, queryClient]);
  return locked;
}

/**
 * Keeps the share listing loaded while the panel is open, as Shared Links
 * and the Captures rows do: the capture card can open the panel over a page
 * that never read it, and the link comes from it.
 */
export function ListingKeeper() {
  useSharedFiles();
  return null;
}

async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success(LINK_COPIED);
  } catch {
    toast.error(COPY_FAILED);
  }
}

/**
 * The header's Copy link button, beside Link settings. Locked, it opens the
 * unlock; with no key on this computer it says why it can't copy.
 */
export function CopyLinkButton({ link }: { link: PanelLink }) {
  if (link.kind === "loading") return null;
  if (link.kind === "locked") return <UnlockCopyButton />;
  const ready = link.kind === "ready";
  const tip = ready ? COPY_LINK : LINK_UNAVAILABLE_NOTE;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={COPY_LINK}
            aria-disabled={ready ? undefined : true}
            onClick={() => {
              if (ready) void copy(link.url);
            }}
            className={cn(ICON_BUTTON, !ready && "cursor-not-allowed opacity-50 hover:bg-transparent")}
            data-testid="insights-copy-link"
          >
            <Copy className="size-4" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className={TIP}>
          {tip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function UnlockCopyButton() {
  const { unlock, busy } = useUnlockFlow();
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${COPY_LINK}: ${UNLOCK_TO_COPY.toLowerCase()}`}
            aria-busy={busy || undefined}
            onClick={() => void unlock()}
            className={ICON_BUTTON}
            data-testid="insights-copy-link"
          >
            <Copy className="size-4" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className={TIP}>
          {LINK_LOCKED_NOTE}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The link itself, under the header's title. The full link is hidden until
 * the owner asks for it (the panel is often on screen while recording), and
 * the Copy button copies it either way. Locked, the link is dots with "Unlock
 * to copy"; with no key on this computer, dots and why.
 */
export function LinkField({ link }: { link: PanelLink }) {
  const [shown, setShown] = useState(false);
  if (link.kind === "loading") {
    return <div aria-hidden data-testid="insights-link-loading" className={cn(SKELETON, "mt-2.5 h-8 rounded-[8px]")} />;
  }
  const box = cn("flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-[8px] border px-2.5 py-1.5 text-xs", HAIRLINE);
  if (link.kind === "ready") {
    return (
      <div className="mt-2.5" data-testid="insights-link">
        <div className={box}>
          <Link2 className={cn("size-3.5 shrink-0", MUTED)} aria-hidden />
          <span className="sr-only">Link: </span>
          <span
            className={cn("min-w-0 flex-1 select-text font-mono text-[11.5px]", STRONG, shown ? "break-all" : "truncate")}
            data-testid="insights-link-text"
          >
            {shown ? link.url : maskedLink(link.url)}
          </span>
          <button
            type="button"
            aria-label={shown ? HIDE_LINK : SHOW_LINK}
            title={shown ? HIDE_LINK : SHOW_LINK}
            onClick={() => setShown((v) => !v)}
            className={cn(ICON_BUTTON, "size-6 rounded-md")}
          >
            {shown ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
          </button>
        </div>
        {link.needsPassword && <p className={cn("mt-1.5 text-xs leading-[1.45]", MUTED)}>{LINK_NEEDS_PASSWORD}</p>}
      </div>
    );
  }
  return (
    <div className="mt-2.5" data-testid="insights-link">
      <div className={box}>
        <Lock className={cn("size-3.5 shrink-0", MUTED)} aria-hidden />
        <span className="sr-only">Link hidden</span>
        <span aria-hidden className={cn("min-w-0 flex-1 truncate font-mono text-[11.5px]", MUTED)}>
          {HIDDEN_DOTS}
        </span>
        {link.kind === "locked" && <UnlockLink />}
      </div>
      <p className={cn("mt-1.5 text-xs leading-[1.45]", MUTED)}>
        {link.kind === "locked" ? LINK_LOCKED_NOTE : LINK_UNAVAILABLE_NOTE}
      </p>
    </div>
  );
}

function UnlockLink() {
  const { unlock, busy } = useUnlockFlow();
  return (
    <button
      type="button"
      onClick={() => void unlock()}
      disabled={busy}
      aria-busy={busy || undefined}
      className={cn(TEXT_LINK, "shrink-0 whitespace-nowrap")}
    >
      {UNLOCK_TO_COPY}
    </button>
  );
}
