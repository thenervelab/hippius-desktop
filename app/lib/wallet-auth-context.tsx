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
import { getWalletRecord, clearWalletDb } from "./helpers/walletDb";
import { hashPasscode, decryptMnemonic } from "./helpers/crypto";
import { isMnemonicValid } from "./helpers/validateMnemonic";
import { invoke } from "@tauri-apps/api/core";
import { useTrayInit } from "./hooks/useTraySync";

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

  // Set session
  const setSession = async (inputMnemonic: string) => {
    try {
      if (!isMnemonicValid(inputMnemonic)) return false;
      const keyring = new Keyring({ type: "sr25519" });
      const pair = keyring.addFromMnemonic(inputMnemonic);

      console.log("[WalletAuth] Signature verified");
      setMnemonic(inputMnemonic);
      setPolkadotAddress(pair.address);

      setWalletManager({ polkadotPair: pair });
      setIsAuthenticated(true);

      // Start sync commands only once when authentication succeeds
      if (!syncInitialized.current) {
        console.log("[WalletAuth] Starting sync for account:", pair.address);
        try {
          await invoke("start_user_profile_sync_tauri", {
            accountId: pair.address,
          });
          await invoke("start_folder_sync_tauri", {
            accountId: pair.address,
            seedPhrase: inputMnemonic,
          });
          await invoke("start_public_folder_sync_tauri", {
            accountId: pair.address,
            seedPhrase: inputMnemonic,
          });
          syncInitialized.current = true;
          console.log("[WalletAuth] Sync commands started successfully");
        } catch (error) {
          console.error("[WalletAuth] Failed to start sync commands:", error);
        }
      }

      return true;
    } catch {
      setMnemonic(null);
      setPolkadotAddress(null);
      setWalletManager(null);

      setIsAuthenticated(false);
      return false;
    }
  };

  // Unlock wallet with passcode
  const unlockWithPasscode = async (passcode: string) => {
    setIsLoading(true);
    try {
      const record = await getWalletRecord();
      if (!record) throw new Error("No wallet record found");
      if (hashPasscode(passcode) !== record.passcodeHash)
        throw new Error("Incorrect passcode");
      const mnemonic = decryptMnemonic(record.encryptedMnemonic, passcode);
      if (!isMnemonicValid(mnemonic)) throw new Error("Decryption failed");

      await setSession(mnemonic);
      setIsLoading(false);
      return true;
    } catch {
      setMnemonic(null);
      setPolkadotAddress(null);
      setWalletManager(null);
      setIsAuthenticated(false);
      setIsLoading(false);

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
        resetWallet,
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
