"use client";

import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, Lock } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
import { FILL, ICON_BUTTON, MUTED, RING, SKELETON } from "./panelStyles";

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
 * The link itself, under the capture's preview: one filled row with the link
 * and a Copy link button. The full link is hidden until the owner asks for it
 * (the panel is often on screen while recording), and Copy copies it either
 * way; it is drawn without its `https://`. Locked, the link is dots with
 * "Unlock to copy" in Copy's place; with no key on this computer, dots and
 * why.
 */
export function LinkField({ link }: { link: PanelLink }) {
  const [shown, setShown] = useState(false);
  if (link.kind === "loading") {
    return <div aria-hidden data-testid="insights-link-loading" className={cn(SKELETON, "h-10 rounded-[10px]")} />;
  }
  const box = cn("flex h-10 min-w-0 items-center gap-1.5 rounded-[10px] pl-3 pr-1 text-[13px]", FILL, RING);
  if (link.kind === "ready") {
    const full = link.url.replace(/^https?:\/\//, "");
    return (
      <div data-testid="insights-link">
        <div className={box}>
          <span className="sr-only">Link: </span>
          <span
            className={cn("min-w-0 flex-1 select-text truncate", MUTED)}
            title={shown ? full : undefined}
            data-testid="insights-link-text"
          >
            {shown ? full : maskedLink(link.url)}
          </span>
          <button
            type="button"
            aria-label={shown ? HIDE_LINK : SHOW_LINK}
            title={shown ? HIDE_LINK : SHOW_LINK}
            onClick={() => setShown((v) => !v)}
            className={cn(ICON_BUTTON, "size-7 rounded-md")}
          >
            {shown ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
          </button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void copy(link.url)}
            className={COPY_BUTTON}
            data-testid="insights-copy-link"
          >
            <Copy className="size-3.5" aria-hidden />
            {COPY_LINK}
          </Button>
        </div>
        {link.needsPassword && <p className={cn("mt-1.5 text-xs leading-[1.45]", MUTED)}>{LINK_NEEDS_PASSWORD}</p>}
      </div>
    );
  }
  return (
    <div data-testid="insights-link">
      <div className={cn(box, link.kind === "unavailable" && "pr-3")}>
        <Lock className={cn("size-3.5 shrink-0", MUTED)} aria-hidden />
        <span className="sr-only">Link hidden</span>
        <span aria-hidden className={cn("min-w-0 flex-1 truncate", MUTED)}>
          {HIDDEN_DOTS}
        </span>
        {link.kind === "locked" && <UnlockButton />}
      </div>
      <p className={cn("mt-1.5 text-xs leading-[1.45]", MUTED)}>
        {link.kind === "locked" ? LINK_LOCKED_NOTE : LINK_UNAVAILABLE_NOTE}
      </p>
    </div>
  );
}

/** Copy link, inside the link's row. */
const COPY_BUTTON = "h-8 shrink-0 gap-1.5 rounded-[7px] px-3 text-[13px] font-medium";

function UnlockButton() {
  const { unlock, busy } = useUnlockFlow();
  return (
    <Button
      variant="primary"
      size="sm"
      onClick={() => void unlock()}
      disabled={busy}
      aria-busy={busy || undefined}
      className={COPY_BUTTON}
    >
      {UNLOCK_TO_COPY}
    </Button>
  );
}
