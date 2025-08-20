/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { Keyring } from "@polkadot/keyring";
import {
  getWalletRecord,
  clearHippiusDesktopDB,
  updateLogoutTime,
  getLogoutTime,
  LOGOUT_TIMES,
} from "./helpers/hippiusDesktopDB";
import { hashPasscode, decryptMnemonic } from "./helpers/crypto";
import { isMnemonicValid } from "./helpers/validateMnemonic";
import { invoke } from "@tauri-apps/api/core";
import { useTrayInit } from "./hooks/useTraySync";
import { cryptoWaitReady } from "@polkadot/util-crypto";

interface WalletContextType {
  isAuthenticated: boolean;
  polkadotAddress: string | null;
  mnemonic: string | null;
  isLoading: boolean;
  walletManager: {
    polkadotPair: any;
  } | null;
  setSession: (mnemonic: string) => Promise<boolean>;
  unlockWithPasscode: (passcode: string) => Promise<boolean>;
  logout: () => Promise<void>;
  resetHippiusDesktop: () => Promise<void>;
  updateSessionTimeout: (timeoutValue: number) => Promise<boolean>;
  logoutTimeValue: number;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [polkadotAddress, setPolkadotAddress] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [walletManager, setWalletManager] = useState<{
    polkadotPair: any;
  } | null>(null);
  const [logoutTimeValue, setLogoutTimeValue] = useState<number>(
    LOGOUT_TIMES.HOURS_24
  );
  const logoutTimer = useRef<NodeJS.Timeout | null>(null);
  const syncInitialized = useRef(false);

  const logout = useCallback(async () => {
    try {
      console.log("[WalletAuth] Starting sync cleanup...");
      await invoke("cleanup_sync");
      console.log("[WalletAuth] Sync cleanup completed");
    } catch (error) {
      console.error("Failed to cleanup sync on logout:", error);
    }

    setMnemonic(null);
    setPolkadotAddress(null);
    setWalletManager(null);
    setIsAuthenticated(false);
    syncInitialized.current = false; // Reset sync flag for next login
  }, []);

  // Update session timeout value
  const updateSessionTimeout = async (
    timeoutValue: number
  ): Promise<boolean> => {
    try {
      const success = await updateLogoutTime(timeoutValue);
      if (success) {
        setLogoutTimeValue(timeoutValue);
        resetLogoutTimer();
        return true;
      }
      return false;
    } catch (err) {
      console.error("Failed to update session timeout:", err);
      return false;
    }
  };

  // Memoize resetLogoutTimer and depend on logout and logoutTimeValue
  const resetLogoutTimer = useCallback(() => {
    if (logoutTimer.current) {
      clearTimeout(logoutTimer.current);
    }

    // Don't set a timer if logout time is set to FOREVER (-1)
    if (logoutTimeValue === LOGOUT_TIMES.FOREVER) {
      return;
    }

    logoutTimer.current = setTimeout(async () => {
      await logout();
    }, logoutTimeValue);
  }, [logout, logoutTimeValue]);

  useEffect(() => {
    if (!isAuthenticated) {
      if (logoutTimer.current) clearTimeout(logoutTimer.current);
      return;
    }
    const events = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "scroll",
    ];
    events.forEach((event) => window.addEventListener(event, resetLogoutTimer));

    resetLogoutTimer();

    return () => {
      if (logoutTimer.current) clearTimeout(logoutTimer.current);
      events.forEach((event) =>
        window.removeEventListener(event, resetLogoutTimer)
      );
    };
  }, [isAuthenticated, resetLogoutTimer]);

  const unlockWithPasscode = async (passcode: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      const record = await getWalletRecord();
      if (!record) throw new Error("No wallet record found");

      if (hashPasscode(passcode) !== record.passcodeHash)
        throw new Error("Incorrect passcode");
      await cryptoWaitReady();
      const mnemonic = decryptMnemonic(record.encryptedMnemonic, passcode);
      if (!isMnemonicValid(mnemonic)) throw new Error("Decryption failed");

      // Set the logout time from the database
      setLogoutTimeValue(record.logoutTime);

      // check that session actually initialized
      const sessionOk = await setSession(mnemonic);
      if (!sessionOk) throw new Error("Session setup failed");

      return true;
    } catch (err) {
      if (err instanceof Error && err.message !== "Incorrect passcode") {
        console.error("[unlockWithPasscode] ", err);
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const setSession = async (inputMnemonic: string): Promise<boolean> => {
    if (!isMnemonicValid(inputMnemonic)) {
      console.error("[setSession] Invalid mnemonic");
      return false;
    }

    try {
      const keyring = new Keyring({ type: "sr25519" });
      const pair = keyring.addFromMnemonic(inputMnemonic);

      console.log("[WalletAuth] Signature verified");
      setMnemonic(inputMnemonic);
      setPolkadotAddress(pair.address);
      setWalletManager({ polkadotPair: pair });
      setIsAuthenticated(true);

      // If logoutTimeValue hasn't been set yet, fetch it from the database
      if (logoutTimeValue === LOGOUT_TIMES.HOURS_24) {
        const timeout = await getLogoutTime();
        setLogoutTimeValue(timeout);
      }

      if (!syncInitialized.current) {
        await invoke("initialize_sync", {
          accountId: pair.address,
          mnemonic: inputMnemonic,
        });
        syncInitialized.current = true;
      }

      return true;
    } catch (err) {
      console.error("[setSession] ", err);
      setMnemonic(null);
      setPolkadotAddress(null);
      setWalletManager(null);
      setIsAuthenticated(false);
      return false;
    }
  };

  // Full reset: clear session + wallet storage
  const resetHippiusDesktop = async () => {
    await clearHippiusDesktopDB();
    await logout();
  };

  useTrayInit();

  return (
    <WalletContext.Provider
      value={{
        isAuthenticated,
        polkadotAddress,
        mnemonic,
        isLoading,
        walletManager,
        setSession,
        unlockWithPasscode,
        logout,
        resetHippiusDesktop,
        updateSessionTimeout,
        logoutTimeValue,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWalletAuth() {
  const ctx = useContext(WalletContext);
  if (!ctx)
    throw new Error("useWalletAuth must be used within WalletAuthProvider");
  return ctx;
}
