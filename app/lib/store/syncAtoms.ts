import { atom } from "jotai";
import type { StagedChanges } from "@/lib/types/syncTypes";

// Stores pending conflicts detected during auto-sync (null when no conflicts)
export const pendingConflictsAtom = atom<StagedChanges | null>(null);

// Tracks whether we've already updated the tray for the current percentage
export const lastUpdatedPercentAtom = atom<number | null>(null);

// Connectivity health state from periodic backend health checks
export type ConnectivityStatusType =
  | "connected"
  | "server_unreachable"
  | "network_offline"
  | "auth_expired"
  | "degraded";

export interface SyncEngineHealthState {
  status: ConnectivityStatusType;
  last_check_time: number | null;
  last_successful_check: number | null;
  consecutive_failures: number;
  server_version: string | null;
  error_message: string | null;
}

export const CONNECTIVITY_STATUS_LABELS: Record<
  Exclude<ConnectivityStatusType, "connected">,
  string
> = {
  network_offline: "Offline",
  server_unreachable: "Server Unreachable",
  auth_expired: "Session Expired",
  degraded: "Connection Issues",
};

export const DEFAULT_SYNC_ENGINE_HEALTH: SyncEngineHealthState = {
  status: "connected",
  last_check_time: null,
  last_successful_check: null,
  consecutive_failures: 0,
  server_version: null,
  error_message: null,
};

export const syncEngineHealthAtom = atom<SyncEngineHealthState>(
  DEFAULT_SYNC_ENGINE_HEALTH
);

/** Info about a file that has repeatedly failed to sync. */
export interface FailedFileInfo {
  label: string;
  path: string;
  fileName: string;
  error: string | null;
  failureCount: number;
}

/** Files that have repeatedly failed to sync (null when no failures at threshold). */
export const failedFilesAtom = atom<FailedFileInfo[] | null>(null);
