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
import { mnemonicToAccount } from "viem/accounts";

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
  address: string | null;
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
  const [address, setAddress] = useState<string | null>(null);

  const logoutTimer = useRef<NodeJS.Timeout | null>(null);

  const logout = useCallback(() => {
    setMnemonic(null);
    setPolkadotAddress(null);
    setWalletManager(null);
    setIsAuthenticated(false);
    setAddress(null);
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

      // Create Ethereum account
      const ethAccount = mnemonicToAccount(inputMnemonic);
      const ethAddress = ethAccount.address;

      console.log("[WalletAuth] Signature verified");
      setMnemonic(inputMnemonic);
      setPolkadotAddress(pair.address);
      setAddress(ethAddress);
      setWalletManager({ polkadotPair: pair });
      setIsAuthenticated(true);
      return true;
    } catch {
      setMnemonic(null);
      setPolkadotAddress(null);
      setWalletManager(null);
      setAddress(null);
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
      setAddress(null);
      return false;
    }
  };

  // Full reset: clear session + wallet storage
  const resetWallet = async () => {
    await clearWalletDb();
    logout();
  };

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
        address,
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
