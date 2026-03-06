"use client";

import { useState, useCallback } from "react";
import {
  saveHcfsConfig,
  getHcfsConfig,
  initializeSync,
  type InitSyncResult,
  type HcfsConfigResult,
} from "../utils/hcfsConfigUtils";
import { getPrivateSyncPath, getAllSyncPaths } from "../utils/syncPathUtils";
import { invoke } from "@tauri-apps/api/core";
import { isSyncConfiguredAtom, syncEngineStatusAtom } from "../global-atoms/unpinAtoms";
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
        // Save the HCFS config first
        await saveHcfsConfig(accountId, serverUrl, password);
        console.log("[useHcfsSync] HCFS config saved");

        // Then initialize sync
        const result = await initializeSync(accountId, label, mnemonic);

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

/**
 * Standalone function for use outside React components (e.g., in wallet-auth-context).
 *
 * Called on login / session restore. Only starts sync if BOTH conditions are met:
 *   1. A sync path has been configured by the user
 *   2. The HCFS encryption password has been set
 *
 * Does NOT auto-create sync paths or prompt for setup.
 * The user triggers setup explicitly by choosing a sync folder in the Files page.
 */
export async function tryAutoInitSync(
  accountId: string,
  mnemonic?: string
): Promise<boolean> {
  try {
    // Eagerly persist the master mnemonic to disk so it survives app restarts.
    // This is a no-op if the master already exists or the HCFS password hasn't
    // been set yet. Without this, an app restart loses the in-memory mnemonic
    // and a subsequent sync setup would generate a random key, making
    // cross-device decryption impossible.
    if (mnemonic) {
      try {
        await invoke("persist_master_mnemonic", { accountId, mnemonic });
      } catch {
        // HCFS config not set up yet — will be saved during initialize_sync
      }
    }

    // Get all configured sync paths
    let syncPaths: { path: string; label: string }[] = [];
    try {
      syncPaths = await getAllSyncPaths(accountId);
    } catch {
      // No sync paths configured yet — try legacy single path
      try {
        const legacy = await getPrivateSyncPath(accountId);
        if (legacy.path) {
          syncPaths = [{ path: legacy.path, label: legacy.label || "default" }];
        }
      } catch {
        // No sync path configured at all
      }
    }

    if (syncPaths.length === 0) {
      console.log("[AutoSync] No sync paths configured, skipping auto-init");
      return false;
    }

    // Check if HCFS config exists
    const config = await getHcfsConfig(accountId);
    if (!config.has_password) {
      console.log("[AutoSync] No HCFS config, skipping auto-init (user will be prompted when setting sync folder)");
      return false;
    }

    // HCFS config exists - mark sync as configured so SyncStoppedAlert can show when needed
    appStore.set(isSyncConfiguredAtom, true);

    // If the user explicitly stopped sync, don't auto-start on login / session restore
    if (
      typeof window !== "undefined" &&
      localStorage.getItem("hippius_sync_stopped") === "true"
    ) {
      console.log("[AutoSync] Sync was explicitly stopped by user, skipping auto-init (but sync is configured)");
      return false;
    }

    // Initialize sync for each configured path
    console.log(`[AutoSync] Auto-initializing ${syncPaths.length} sync path(s)...`);
    let anyInitialized = false;
    for (const sp of syncPaths) {
      try {
        const result = await initializeSync(accountId, sp.label, mnemonic);
        console.log(`[AutoSync] Sync initialized for '${sp.label}':`, result.user_id);
        anyInitialized = true;
      } catch (err) {
        console.error(`[AutoSync] Failed to init sync for label '${sp.label}':`, err);
      }
    }

    // Mark sync engine as active so the "Syncing is stopped" banner clears
    if (anyInitialized) {
      appStore.set(syncEngineStatusAtom, "active");
    }

    return anyInitialized;
  } catch (err) {
    console.error("[AutoSync] Auto-sync init failed:", err);
    return false;
  }
}
