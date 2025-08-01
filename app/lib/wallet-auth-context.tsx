/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback
} from "react";
import { Keyring } from "@polkadot/keyring";
import { getWalletRecord, clearWalletDb } from "./helpers/walletDb";
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
  logout: () => void;
  resetWallet: () => void;
}
const INACTIVITY_TIMEOUT = 15 * 60 * 1000;

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletAuthProvider({
  children
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

  const logoutTimer = useRef<NodeJS.Timeout | null>(null);
  const syncInitialized = useRef(false);

  const logout = useCallback(() => {
    setMnemonic(null);
    setPolkadotAddress(null);
    setWalletManager(null);
    setIsAuthenticated(false);
    syncInitialized.current = false; // Reset sync flag for next login
  }, []);

  // Memoize resetLogoutTimer and depend on logout
  const resetLogoutTimer = useCallback(() => {
    if (logoutTimer.current) {
      clearTimeout(logoutTimer.current);
    }
    logoutTimer.current = setTimeout(() => {
      logout();
    }, INACTIVITY_TIMEOUT);
  }, [logout]);

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
      "scroll"
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

      if (!syncInitialized.current) {
        console.log("[WalletAuth] Starting sync for account:", pair.address);
        invoke("start_user_profile_sync_tauri", {
          accountId: pair.address
        });
        invoke("start_folder_sync_tauri", {
          accountId: pair.address,
          seedPhrase: inputMnemonic
        });
        invoke("start_public_folder_sync_tauri", {
          accountId: pair.address,
          seedPhrase: inputMnemonic
        });
        syncInitialized.current = true;
        console.log("[WalletAuth] Sync commands started successfully");
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
  const resetWallet = async () => {
    await clearWalletDb();
    logout();
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
        resetWallet
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
