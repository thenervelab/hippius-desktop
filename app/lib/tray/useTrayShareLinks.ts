import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ShareSummary } from "@/app/lib/tauri/shares";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  buildShareIndex,
  captureSharesFrom,
  EMPTY_SHARE_INDEX,
  shareLookups,
  type ShareLinkIndex,
} from "@/app/lib/utils/fileLinks";
import { onTauriEvent } from "@/app/lib/utils/tauriListeners";
import { trayRowRelativePath } from "./trayRowActions";

/** Rust's "the popover is now visible" event (`toggle_tray_panel`). */
const TRAY_SHOWN_EVENT = "hippius:tray-panel-shown";

/**
 * How often the listing is read again while the popover stays open. Each
 * open reads it anyway, so this only keeps a popover left open honest; the
 * main window's own poll is separate (the two webviews share no cache).
 */
export const TRAY_SHARES_REFRESH_MS = 30_000;

/**
 * The account's share links for the tray popover's rows, so a row shows the
 * same link icon the Drive, Captures and Recent Files rows show, by the same
 * rule (`captureSharesFrom`): a capture's link made in the web console or
 * the extension counts.
 *
 * The popover mounts no providers (no react-query cache to share with the
 * main window), so it reads `hcfs_list_shares` itself: each time it is shown
 * (a link made, revoked or made in the console since is picked up then),
 * every {@link TRAY_SHARES_REFRESH_MS} while it stays shown, and after its own
 * Copy link (`reload`). Never while hidden, and never two reads at once.
 *
 * A failed read keeps what was known: a row must not lose its icon because
 * one read failed, and an unknown listing never reads as "no link".
 *
 * @param enabled the session is hydrated (`sessionReady`); before that the
 *   account-scoped command would be refused.
 */
export function useTrayShareLinks(enabled: boolean) {
  const [index, setIndex] = useState<ShareLinkIndex>(EMPTY_SHARE_INDEX);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const inFlight = useRef(false);
  const shown = useRef(false);

  const reload = useCallback(async () => {
    if (!enabledRef.current || inFlight.current) return;
    inFlight.current = true;
    try {
      const rows = await invoke<ShareSummary[]>("hcfs_list_shares");
      setIndex(buildShareIndex(Array.isArray(rows) ? rows : []));
    } catch (error) {
      console.warn("[TrayPanel] Could not read the share links:", error);
    } finally {
      inFlight.current = false;
    }
  }, []);

  // First read once the session can answer (the popover is prewarmed hidden
  // at boot, so this is one read per session, not one per poll).
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  useEffect(() => {
    const stopShown = onTauriEvent(TRAY_SHOWN_EVENT, () => {
      shown.current = true;
      void reload();
    });
    let unlistenFocus: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        const wasShown = shown.current;
        shown.current = focused;
        // The shown event already read it on this open.
        if (focused && !wasShown) void reload();
      })
      .then((un) => {
        if (disposed) un();
        else unlistenFocus = un;
      })
      .catch((error) => console.warn("[TrayPanel] focus listener failed:", error));
    const interval = window.setInterval(() => {
      if (shown.current) void reload();
    }, TRAY_SHARES_REFRESH_MS);
    return () => {
      disposed = true;
      stopShown();
      unlistenFocus?.();
      window.clearInterval(interval);
    };
  }, [reload]);

  const lookups = useMemo(() => shareLookups(index), [index]);
  const linksFor = useCallback(
    (item: FormattedUserFile): ShareSummary[] =>
      item.isFolder ? [] : captureSharesFrom(lookups, item.label, trayRowRelativePath(item), item.size),
    [lookups],
  );

  return { linksFor, reload };
}
