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
import { saveSession, getSession, clearSession, clearApiAuth } from "./helpers/sessionStore";

import { useRouter } from "next/navigation";

import { hashPasscode, decryptMnemonic } from "./helpers/crypto";
import { isMnemonicValid } from "./helpers/validateMnemonic";
import { invoke } from "@tauri-apps/api/core";
import { useTrayInit } from "./hooks/useTraySync";
import { cryptoWaitReady } from "@polkadot/util-crypto";

interface WalletContextType {
  isAuthenticated: boolean;
  address: string | null;
  polkadotAddress: string | null;
  mnemonic: string | null;
  isLoading: boolean;
  walletManager: {
    polkadotPair: any;
  } | null;
  authType: "mnemonic" | "oauth" | null;
  oauthSession: import("@/app/lib/types/oAuth").OAuthSession | null;
  login: (mnemonic: string) => Promise<void>;
  setOAuthSession: (session: import("@/app/lib/types/oAuth").OAuthSession) => void;
  setSession: (
    mnemonic: string,
    logoutTimeInMinutes?: number
  ) => Promise<boolean>;
  unlockWithPasscode: (
    passcode: string,
    logoutTimeInMinutes?: number
  ) => Promise<boolean>;
  logout: (redirectPath?: string) => Promise<void>;
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
  const [address, setAddress] = useState<string | null>(null);
  const [polkadotAddress, setPolkadotAddress] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [walletManager, setWalletManager] = useState<{
    polkadotPair: any;
  } | null>(null);
  const [authType, setAuthType] = useState<"mnemonic" | "oauth" | null>(null);
  const [oauthSession, setOAuthSessionState] = useState<import("@/app/lib/types/oAuth").OAuthSession | null>(null);
  const [sessionTimeRemaining, setSessionTimeRemaining] = useState<
    number | null
  >(null);

  const syncInitialized = useRef(false);
  const logoutTimerRef = useRef<NodeJS.Timeout | null>(null);

  const logout = useCallback(async (redirectPath?: string) => {
    try {
      console.log("[WalletAuth] Starting sync cleanup...");
      invoke("cleanup_sync");
      console.log("[WalletAuth] Sync cleanup completed");

      await clearSession();
      await clearApiAuth();

      // Clear OAuth session if present
      if (typeof window !== "undefined") {
        localStorage.removeItem("hippius_oauth_session");
        localStorage.removeItem("hippius_oauth_session_expiry");
        // Clear deep link processing flags to prevent re-triggering
        sessionStorage.removeItem("last_processed_deep_link");
        // Mark this as manual navigation so deep link doesn't re-trigger
        sessionStorage.setItem("manual_navigation", "true");
        console.log("[WalletAuth] Cleared deep link flags and set manual navigation");
      }
    } catch (error) {
      console.error("Failed to cleanup sync on logout:", error);
    }

    // Clear the logout timer if it exists
    if (logoutTimerRef.current) {
      clearTimeout(logoutTimerRef.current);
      logoutTimerRef.current = null;
    }

    setMnemonic(null);
    setAddress(null);
    setPolkadotAddress(null);
    setWalletManager(null);
    setAuthType(null);
    setOAuthSessionState(null);
    setIsAuthenticated(false);
    setSessionTimeRemaining(null);
    syncInitialized.current = false; // Reset sync flag for next login

    // Optionally redirect after logout
    if (redirectPath && typeof window !== "undefined") {
      router.push(redirectPath);
    }
  }, [router]);

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

      // First, check for OAuth session in localStorage
      if (typeof window !== "undefined") {
        const storedSession = localStorage.getItem("hippius_oauth_session");
        const storedExpiry = localStorage.getItem("hippius_oauth_session_expiry");

        if (storedSession && storedExpiry) {
          const expiryTime = parseInt(storedExpiry, 10);

          // Check if session is still valid
          if (Date.now() < expiryTime) {
            try {
              const oauthSessionData = JSON.parse(storedSession);
              console.log("[WalletAuth] Restoring OAuth session:", oauthSessionData.username);

              // Restore OAuth session state
              setOAuthSessionState(oauthSessionData);
              setPolkadotAddress(oauthSessionData.substrateAddress || null);
              setAuthType("oauth");
              setIsAuthenticated(true);

              console.log("[WalletAuth] ✅ OAuth session restored");
              return; // Skip mnemonic session check
            } catch (error) {
              console.error("[WalletAuth] Failed to restore OAuth session:", error);
              // Clear invalid session data
              localStorage.removeItem("hippius_oauth_session");
              localStorage.removeItem("hippius_oauth_session_expiry");
            }
          } else {
            console.log("[WalletAuth] OAuth session expired, clearing");
            localStorage.removeItem("hippius_oauth_session");
            localStorage.removeItem("hippius_oauth_session_expiry");
          }
        }
      }

      // Check for mnemonic session
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

  // Mnemonic login with challenge-based authentication
  const login = async (inputMnemonic: string): Promise<void> => {
    setIsLoading(true);
    try {
      console.log("[WalletAuth] Starting mnemonic login with challenge");

      // Wait for crypto WASM to be ready
      await cryptoWaitReady();

      // Import viem for Ethereum account
      const { mnemonicToAccount } = await import("viem/accounts");

      // Create Polkadot account
      const keyring = new Keyring({ type: "sr25519" });
      const polkadotPair = keyring.addFromMnemonic(inputMnemonic);
      const polkadotAddr = polkadotPair.address;

      // Create Ethereum account
      const ethAccount = mnemonicToAccount(inputMnemonic);
      const ethAddress = ethAccount.address;

      console.log("[WalletAuth] Derived addresses:", {
        eth: ethAddress,
        polkadot: polkadotAddr,
      });

      // Import auth service dynamically
      const { authService } = await import("./services/authService");

      // Request challenge
      const challengeData = await authService.requestChallenge(
        ethAddress,
        polkadotAddr
      );
      console.log("[WalletAuth] Got challenge:", challengeData.message);

      // Sign challenge
      const signature = await ethAccount.signMessage({
        message: challengeData.message,
      });
      console.log("[WalletAuth] Generated signature");

      // Verify signature and get session
      await authService.verifySignature({
        signature,
        address: ethAddress,
        substrateAddress: polkadotAddr,
        referralCode: null,
      });
      console.log("[WalletAuth] Signature verified");

      // Get session from auth service (already stored)
      const session = authService.getSession();
      if (!session) {
        throw new Error("Session not stored properly after verification");
      }

      console.log("[WalletAuth] Mnemonic login successful");

      // Update state
      setMnemonic(inputMnemonic);
      setPolkadotAddress(polkadotAddr);
      setWalletManager({ polkadotPair });
      setOAuthSessionState(session);
      setAuthType("mnemonic");
      setIsAuthenticated(true);

      // Initialize sync with the mnemonic
      if (!syncInitialized.current) {
        await invoke("initialize_sync", {
          accountId: polkadotAddr,
          mnemonic: inputMnemonic,
        });
        syncInitialized.current = true;
      }
    } catch (error) {
      console.error("[WalletAuth] Login failed:", error);
      // Clear sensitive data on error
      setMnemonic(null);
      setPolkadotAddress(null);
      setWalletManager(null);
      setAuthType(null);
      setIsAuthenticated(false);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Set OAuth session from external OAuth flow
  const setOAuthSession = (session: import("@/app/lib/types/oAuth").OAuthSession) => {
    console.log("[WalletAuth] Setting OAuth session:", session.username);

    // Persist to localStorage immediately
    if (typeof window !== "undefined") {
      localStorage.setItem("hippius_oauth_session", JSON.stringify(session));
      // Set expiry to 30 days from now
      const expiryTime = Date.now() + (30 * 24 * 60 * 60 * 1000);
      localStorage.setItem("hippius_oauth_session_expiry", expiryTime.toString());
    }

    // Update state
    setOAuthSessionState(session);
    setPolkadotAddress(session.substrateAddress || null);
    setAuthType("oauth");
    setIsAuthenticated(true);

    console.log("[WalletAuth] ✅ OAuth session persisted and state updated");
  };

  // Full reset: clear session + wallet storage
  const resetHippiusDesktop = async () => {
    await clearHippiusDesktopDB();
    await logout();
  };

  useTrayInit(polkadotAddress || "");

  return (
    <WalletContext.Provider
      value={{
        isAuthenticated,
        address,
        polkadotAddress,
        mnemonic,
        isLoading,
        walletManager,
        authType,
        oauthSession,
        login,
        setOAuthSession,
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
