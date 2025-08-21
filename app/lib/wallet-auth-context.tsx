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
} from "./helpers/hippiusDesktopDB";
import { saveSession, getSession, clearSession } from "./helpers/sessionStore";

import { useRouter } from "next/navigation";

import { hashPasscode, decryptMnemonic } from "./helpers/crypto";
import { isMnemonicValid } from "./helpers/validateMnemonic";
import { invoke } from "@tauri-apps/api/core";
import { useTrayInit } from "./hooks/useTraySync";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { toast } from "sonner";

interface WalletContextType {
  isAuthenticated: boolean;
  polkadotAddress: string | null;
  mnemonic: string | null;
  isLoading: boolean;
  walletManager: {
    polkadotPair: any;
  } | null;
  setSession: (
    mnemonic: string,
    logoutTimeInMinutes?: number
  ) => Promise<boolean>;
  unlockWithPasscode: (
    passcode: string,
    logoutTimeInMinutes?: number
  ) => Promise<boolean>;
  logout: () => Promise<void>;
  resetHippiusDesktop: () => Promise<void>;
  sessionTimeRemaining: number | null;
}
const MAX_DELAY = 2_147_483_647; // ~24.8 days

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [polkadotAddress, setPolkadotAddress] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [walletManager, setWalletManager] = useState<{
    polkadotPair: any;
  } | null>(null);
  const [sessionTimeRemaining, setSessionTimeRemaining] = useState<
    number | null
  >(null);

  const syncInitialized = useRef(false);
  const logoutTimerRef = useRef<NodeJS.Timeout | null>(null);

  const logout = useCallback(async () => {
    try {
      console.log("[WalletAuth] Starting sync cleanup...");
      invoke("cleanup_sync");
      console.log("[WalletAuth] Sync cleanup completed");

      // Clear session from database
      await clearSession();
    } catch (error) {
      console.error("Failed to cleanup sync on logout:", error);
    }

    // Clear the logout timer if it exists
    if (logoutTimerRef.current) {
      clearTimeout(logoutTimerRef.current);
      logoutTimerRef.current = null;
    }

    setMnemonic(null);
    setPolkadotAddress(null);
    setWalletManager(null);
    setIsAuthenticated(false);
    setSessionTimeRemaining(null);
    syncInitialized.current = false; // Reset sync flag for next login
  }, []);

  function scheduleLogout(ms: number) {
    if (ms === Infinity) return; // keep me logged in

    const delay = Math.min(Math.max(ms, 0), MAX_DELAY);
    logoutTimerRef.current = setTimeout(() => {
      if (ms > MAX_DELAY) {
        scheduleLogout(ms - MAX_DELAY); // chain next chunk
      } else {
        logout();
      }
    }, delay);
  }

  useEffect(() => {
    const bootOnce = { done: false }; // local guard

    const setupSessionTimeout = async () => {
      if (bootOnce.done) return;
      bootOnce.done = true;

      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = null;
      }

      const session = await getSession();
      if (!session) {
        setSessionTimeRemaining(null);
        return;
      }

      // Don't leak mnemonic in logs/toasts
      // toast.success("Session restored");  // optional

      const timeRemaining = session.logoutTimeStamp - Date.now();
      setSessionTimeRemaining(Math.max(timeRemaining, 0));

      if (timeRemaining <= 0 && !isAuthenticated) {
        await logout();
        return;
      }

      // Re-adopt the session minutes to avoid -1 bug
      const ok = await setSession(
        session.mnemonic,
        session.logoutTimeInMinutes
      );
      if (ok) router.push("/");
    };

    setupSessionTimeout();

    return () => {
      if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
    };
  }, [logout, router]);

  const unlockWithPasscode = async (
    passcode: string,
    logoutTimeInMinutes?: number
  ): Promise<boolean> => {
    setIsLoading(true);
    try {
      const record = await getWalletRecord();
      if (!record) throw new Error("No wallet record found");

      if (hashPasscode(passcode) !== record.passcodeHash)
        throw new Error("Incorrect passcode");
      await cryptoWaitReady();
      const mnemonic = decryptMnemonic(record.encryptedMnemonic, passcode);
      if (!isMnemonicValid(mnemonic)) throw new Error("Decryption failed");

      // check that session actually initialized
      const sessionOk = await setSession(mnemonic, logoutTimeInMinutes);
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

  const setSession = async (
    inputMnemonic: string,
    logoutTimeInMinutes?: number
  ): Promise<boolean> => {
    if (!isMnemonicValid(inputMnemonic)) {
      console.error("[setSession] Invalid mnemonic");
      return false;
    }
    await cryptoWaitReady();
    try {
      const keyring = new Keyring({ type: "sr25519" });
      const pair = keyring.addFromMnemonic(inputMnemonic);

      console.log("[WalletAuth] Signature verified");
      setMnemonic(inputMnemonic);
      setPolkadotAddress(pair.address);
      setWalletManager({ polkadotPair: pair });
      setIsAuthenticated(true);

      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = null;
      }

      // Persist session and get timestamp
      const logoutTimeStamp = await saveSession(
        inputMnemonic,
        logoutTimeInMinutes
      );

      const timeRemaining = +logoutTimeStamp - Date.now();
      setSessionTimeRemaining(timeRemaining);

      // If minutes === -1, we won't schedule; else schedule in safe chunks
      const effMinutes =
        logoutTimeInMinutes ??
        (await getSession())?.logoutTimeInMinutes ??
        1440;

      scheduleLogout(effMinutes === -1 ? Infinity : timeRemaining);

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
        sessionTimeRemaining,
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
