"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import useIsOnline from "@/lib/hooks/useIsOnline";

/**
 * WhatsApp-style "Computer not connected" banner.
 *
 * Mounted inside the page content area (the `<main>` in `ResponsiveContent`),
 * NOT in the top bar / sidebar — so reconnecting only refreshes the current
 * page's data and the app shell never reloads.
 *
 * Why a banner instead of per-table error states: every read in the desktop
 * app goes through local Tauri IPC that resolves OK even when offline (returns
 * empty / cached / local-disk data), so individual queries never error on
 * their own. `useIsOnline` (navigator.onLine) is the single source of truth
 * for "no connection", and this banner is the one explicit signal.
 *
 * "Reconnect" refetches every *active* (mounted) query — that's the current
 * page's data — without remounting anything. When the OS reports the
 * connection is back, the same refresh runs automatically and the banner hides.
 */
export default function OfflineBanner({ className }: { className?: string }) {
  const isOnline = useIsOnline();
  const queryClient = useQueryClient();
  const [isReconnecting, setIsReconnecting] = useState(false);

  const refreshActiveData = useCallback(async () => {
    setIsReconnecting(true);
    try {
      // `type: "active"` = only queries with a live observer, i.e. the data
      // the currently-mounted page is showing. The top bar / sidebar keep
      // their components; their queries just refetch in place.
      await queryClient.refetchQueries({ type: "active" });
    } finally {
      setIsReconnecting(false);
    }
  }, [queryClient]);

  // Auto-refresh the page's data the moment the OS reports we're back online,
  // so the user doesn't have to click anything after their connection returns.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (!isOnline) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      void refreshActiveData();
    }
  }, [isOnline, refreshActiveData]);

  if (isOnline) return null;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border px-4 py-3 mt-2",
        "border-warning-50/35 bg-warning-50/[0.07]",
        "dark:border-warning-50/25 dark:bg-warning-50/[0.12]",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning-50/15 text-warning-50 dark:bg-warning-50/20 dark:text-warning-40">
          <AlertTriangle className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-grey-10 dark:text-white">
            Computer not connected
          </p>
          <p className="text-xs text-grey-50 dark:text-grey-dark-700">
            Make sure your computer has an active internet connection.
          </p>
        </div>
        <button
          onClick={refreshActiveData}
          disabled={isReconnecting}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5",
            "text-sm font-semibold text-success-40 transition-colors",
            "hover:bg-success-50/10 hover:text-success-50",
            "dark:text-success-50 dark:hover:bg-success-50/15",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <RefreshCw
            className={cn("size-3.5", isReconnecting && "animate-spin")}
          />
          {isReconnecting ? "Reconnecting…" : "Reconnect"}
        </button>
      </div>
    </div>
  );
}
