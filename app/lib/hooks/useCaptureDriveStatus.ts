"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import {
  CAPTURE_DRIVE_CHANGED_EVENT,
  getCaptureDriveStatus,
  type CaptureDriveStatus,
} from "@/app/lib/tauri/capture";

export const CAPTURE_DRIVE_STATUS_QUERY_KEY = "capture-drive-status";

/**
 * Where the captures drive stands, from Rust's `capture_drive_status`:
 * ready (and which drive), not set up yet, or chosen but not added yet.
 * Every decision is Rust's; read again whenever Rust says the drive changed
 * and when a capture was delivered (the first one sets the drive up).
 */
export function useCaptureDriveStatus(enabled = true) {
  const { polkadotAddress } = useWalletAuth();
  const query = useQuery<CaptureDriveStatus>({
    queryKey: [CAPTURE_DRIVE_STATUS_QUERY_KEY, polkadotAddress],
    queryFn: getCaptureDriveStatus,
    enabled: enabled && Boolean(polkadotAddress),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const { refetch } = query;

  useEffect(() => {
    if (!enabled) return;
    const again = () => void refetch();
    const unlisteners = [listen(CAPTURE_DRIVE_CHANGED_EVENT, again), listen("capture_delivered", again)];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn()).catch(() => undefined);
    };
  }, [enabled, refetch]);

  return query;
}

export default useCaptureDriveStatus;
