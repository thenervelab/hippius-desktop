"use client";

import { useState, useCallback } from "react";
import {
  getHcfsConfig,
  initializeSync,
  type InitSyncResult,
  type HcfsConfigResult,
} from "../utils/hcfsConfigUtils";
import { invoke } from "@tauri-apps/api/core";
import { isSyncConfiguredAtom } from "../global-atoms/unpinAtoms";
import { migrationLockAtom } from "../global-atoms/migrationAtoms";
import { appStore } from "@/lib/store/jotaiStore";

export interface UseHcfsSyncResult {
  tryInitializeSync: (accountId: string, label: string, mnemonic?: string) => Promise<boolean>;
  setupAndInitialize: (
    accountId: string,
    label: string,
    serverUrl: string,
    password: string,
    mnemonic?: string
  ) => Promise<InitSyncResult | null>;
  checkConfig: (accountId: string) => Promise<HcfsConfigResult>;
  isInitializing: boolean;
  mnemonicToBackup: string | null;
  clearMnemonicBackup: () => void;
  needsSetup: boolean;
  setNeedsSetup: (value: boolean) => void;
  error: string | null;
  clearError: () => void;
}

export function useHcfsSync(): UseHcfsSyncResult {
  const [isInitializing, setIsInitializing] = useState(false);
  const [mnemonicToBackup, setMnemonicToBackup] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkConfig = useCallback(async (accountId: string): Promise<HcfsConfigResult> => {
    try {
      return await getHcfsConfig(accountId);
    } catch (err) {
      console.error("[useHcfsSync] Failed to check config:", err);
      return { server_url: "", has_password: false };
    }
  }, []);

  /** Initialize sync if HCFS config already exists.
   *  The Rust `initialize_sync` command handles cleanup of any previous sync loop internally,
   *  so callers do not need to call `stop_sync` first. */
  const tryInitializeSync = useCallback(
    async (accountId: string, label: string, mnemonic?: string): Promise<boolean> => {
      setError(null);

      // Block sync while server-side migration is in progress
      if (appStore.get(migrationLockAtom)) {
        console.log("[useHcfsSync] Migration in progress, sync blocked");
        return false;
      }

      try {
        // Check if HCFS config exists
        const config = await checkConfig(accountId);
        if (!config.has_password) {
          console.log("[useHcfsSync] No HCFS config, setup required");
          setNeedsSetup(true);
          return false;
        }

        setIsInitializing(true);

        // Call initialize_sync
        const result = await initializeSync(accountId, label, mnemonic);

        // If a new mnemonic was generated, show backup dialog
        if (result.mnemonic) {
          setMnemonicToBackup(result.mnemonic);
        }

        console.log("[useHcfsSync] Sync initialized successfully:", result.user_id);
        setNeedsSetup(false);
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error("[useHcfsSync] Failed to initialize sync:", errorMsg);
        setError(errorMsg);
        return false;
      } finally {
        setIsInitializing(false);
      }
    },
    [checkConfig]
  );

  /** Save HCFS config and initialize sync.
   *  Callers MUST call `invoke("stop_sync")` before this if a sync loop is already running. */
  const setupAndInitialize = useCallback(
    async (
      accountId: string,
      label: string,
      serverUrl: string,
      password: string,
      mnemonic?: string
    ): Promise<InitSyncResult | null> => {
      setError(null);
      setIsInitializing(true);

      try {
        // Single Rust call: saves config + persists mnemonic + initializes sync
        const result = await invoke<InitSyncResult>("setup_and_init_sync", {
          accountId,
          label,
          serverUrl,
          password,
          mnemonic: mnemonic ?? null,
        });

        // If a new mnemonic was generated, show backup dialog
        if (result.mnemonic) {
          setMnemonicToBackup(result.mnemonic);
        }

        setNeedsSetup(false);
        console.log("[useHcfsSync] Setup and init completed:", result.user_id);
        return result;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error("[useHcfsSync] Setup failed:", errorMsg);
        setError(errorMsg);
        return null;
      } finally {
        setIsInitializing(false);
      }
    },
    []
  );

  const clearMnemonicBackup = useCallback(() => {
    setMnemonicToBackup(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    tryInitializeSync,
    setupAndInitialize,
    checkConfig,
    isInitializing,
    mnemonicToBackup,
    clearMnemonicBackup,
    needsSetup,
    setNeedsSetup,
    error,
    clearError,
  };
}

interface AutoInitResult {
  anyInitialized: boolean;
  isConfigured: boolean;
  skippedReason: string | null;
}

/**
 * Standalone function for use outside React components (e.g., in wallet-auth-context).
 *
 * All business logic (migration lock, mnemonic persistence, path queries,
 * HCFS config check, path filtering, sequential init) lives in Rust.
 * This function is a thin wrapper that calls Rust and updates the
 * `isSyncConfigured` atom — per-drive sync status is mirrored from
 * Rust by `useDriveStatuses`.
 */
export async function tryAutoInitSync(
  accountId: string,
  mnemonic?: string
): Promise<boolean> {
  try {
    const result = await invoke<AutoInitResult>("auto_init_sync", {
      accountId,
      mnemonic: mnemonic ?? null,
    });

    if (result.isConfigured) {
      appStore.set(isSyncConfiguredAtom, true);
    }
    // Per-drive Active status is emitted by Rust from `auto_init_sync`
    // for each successful drive init — useDriveStatuses picks them up
    // via the hcfs_drive_status_changed event.

    return result.anyInitialized;
  } catch (err) {
    console.error("[AutoSync] auto_init_sync failed:", err);
    return false;
  }
}
