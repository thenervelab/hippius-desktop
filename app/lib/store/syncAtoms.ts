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

/**
 * Payload of the `hcfs_credits_exhausted` Tauri event. Mirrors the Rust
 * `CreditsExhaustedPayload` (camelCase via serde). `balanceCents` and
 * `requiredCents` are integers in cents — the FE divides by 100 only at
 * the render site so arithmetic stays loss-free.
 */
export interface CreditsExhaustedInfo {
  label: string;
  balanceCents: number;
  requiredCents: number;
  /** Running count of 402'd files in the current sync cycle. */
  fileCount: number;
}

/**
 * Latest `hcfs_credits_exhausted` payload, or `null` when the banner
 * should be hidden (no 402 yet this session, dismissed by the user, or
 * cleared by a fresh `hcfs_sync_started`). The banner reads this atom;
 * `useCreditsExhausted` is the only writer (the corresponding Rust IPC
 * does not exist by design — banner state is event-driven, not RPC).
 *
 * Dismissal sets it to `null`; a subsequent `hcfs_credits_exhausted`
 * event re-raises the banner. This matches the per-cycle ephemerality
 * contract: dismissing the banner does NOT permanently hide it for
 * future failures.
 */
export const creditsExhaustedAtom = atom<CreditsExhaustedInfo | null>(null);
