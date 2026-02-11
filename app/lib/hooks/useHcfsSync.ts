"use client";

import { useState, useCallback } from "react";
import {
  saveHcfsConfig,
  getHcfsConfig,
  initializeSync,
  type InitSyncResult,
  type HcfsConfigResult,
} from "../utils/hcfsConfigUtils";
import { getPrivateSyncPath } from "../utils/syncPathUtils";

export interface UseHcfsSyncResult {
  tryInitializeSync: (accountId: string, mnemonic?: string) => Promise<boolean>;
  setupAndInitialize: (
    accountId: string,
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
    async (accountId: string, mnemonic?: string): Promise<boolean> => {
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
        const result = await initializeSync(accountId, mnemonic);

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
        const result = await initializeSync(accountId, mnemonic);

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
    // Check if sync path has been configured by the user
    let syncPath = "";
    try {
      syncPath = await getPrivateSyncPath(accountId);
    } catch {
      // No sync path configured yet — that's fine, user hasn't set one
    }

    if (!syncPath || syncPath.length === 0) {
      console.log("[AutoSync] No sync path configured, skipping auto-init");
      return false;
    }

    // Check if HCFS config exists
    const config = await getHcfsConfig(accountId);
    if (!config.has_password) {
      console.log("[AutoSync] No HCFS config, skipping auto-init (user will be prompted when setting sync folder)");
      return false;
    }

    // Both sync path and config exist — initialize sync
    console.log("[AutoSync] Auto-initializing sync...");
    const result = await initializeSync(accountId, mnemonic);
    console.log("[AutoSync] Sync initialized:", result.user_id);
    return true;
  } catch (err) {
    console.error("[AutoSync] Auto-sync init failed:", err);
    return false;
  }
}
