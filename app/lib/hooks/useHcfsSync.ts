"use client";

import { useState, useCallback } from "react";
import {
  saveHcfsConfig,
  getHcfsConfig,
  initializeSync,
  type InitSyncResult,
  type HcfsConfigResult,
} from "../utils/hcfsConfigUtils";
import { getPrivateSyncPath, setPrivateSyncPath } from "../utils/syncPathUtils";

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

/** Derive the same 8-hex-char key the Rust backend uses (SHA-256 of accountId).
 *  Keeps the per-account directory name consistent with DB namespacing.
 *  Must match `account_key()` in src-tauri/src/utils/account_key.rs.
 *  Test vector: accountShortId("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY") → "9b5f1775" */
async function accountShortId(accountId: string): Promise<string> {
  const data = new TextEncoder().encode(accountId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

/** Standalone function for use outside React components (e.g., in wallet-auth-context).
 *  Safe to call on login — auto-creates sync path if missing, returns "needs_setup" when
 *  HCFS config (password) is not yet configured so callers can prompt the user.
 *  The Rust `initialize_sync` command handles cleanup of any previous sync loop internally. */
export async function tryAutoInitSync(
  accountId: string,
  mnemonic?: string
): Promise<boolean | "needs_setup"> {
  try {
    // Check if sync path exists — auto-create if missing.
    // getPrivateSyncPath throws when no row exists (fresh install), so treat errors as "no path".
    let syncPath = "";
    try {
      syncPath = await getPrivateSyncPath(accountId);
    } catch {
      // No sync path configured yet
    }
    if (!syncPath || syncPath.length === 0) {
      // Use a per-account subdirectory so different mnemonics get isolated folders.
      // Derive the same SHA-256 based short ID the backend uses for DB namespacing.
      const shortId = await accountShortId(accountId);
      console.log(`[AutoSync] No sync path, creating default ~/Documents/Hippius/${shortId}`);
      try {
        const { documentDir, join } = await import("@tauri-apps/api/path");
        const docsDir = await documentDir();
        const defaultPath = await join(docsDir, "Hippius", shortId);
        await setPrivateSyncPath(defaultPath, accountId);
        syncPath = defaultPath;
        console.log("[AutoSync] Default sync path created:", syncPath);
      } catch (pathErr) {
        console.error("[AutoSync] Failed to create default sync path:", pathErr);
        return false;
      }
    }

    // Check if HCFS config exists
    const config = await getHcfsConfig(accountId);
    if (!config.has_password) {
      console.log("[AutoSync] No HCFS config, setup required");
      return "needs_setup";
    }

    // Initialize sync
    console.log("[AutoSync] Auto-initializing sync...");
    const result = await initializeSync(accountId, mnemonic);
    console.log("[AutoSync] Sync initialized:", result.user_id);
    return true;
  } catch (err) {
    console.error("[AutoSync] Auto-sync init failed:", err);
    return false;
  }
}
