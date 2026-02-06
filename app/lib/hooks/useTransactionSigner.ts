"use client";

import { useState, useCallback } from "react";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import type { KeyringPair } from "@polkadot/keyring/types";

interface UseTransactionSignerReturn {
  /** Whether local wallet is being used (requires passcode) */
  requiresPasscode: boolean;
  /** Currently loaded keypair (only available if passcode verified) */
  signerPair: KeyringPair | null;
  /** Whether the signer is ready to sign transactions */
  isReady: boolean;
  /** Current wallet address */
  address: string | null;
  /** Verify passcode and get signer */
  requestSigner: (passcode: string) => Promise<KeyringPair | null>;
  /** Get signer if already unlocked (for walletManager flow) */
  getAvailableSigner: () => KeyringPair | null;
  /** Clear the current signer */
  clearSigner: () => void;
}

/**
 * Hook to get a transaction signer that works with both
 * local wallets (with passcode) and regular wallets (from walletManager)
 */
export const useTransactionSigner = (): UseTransactionSignerReturn => {
  const { activeWallet, hasWallets, unlockWallet, unlockedPair, lockWallet } =
    useLocalWallet();
  const { walletManager, polkadotAddress } = useWalletAuth();
  const [temporaryPair, setTemporaryPair] = useState<KeyringPair | null>(null);

  // Determine if we need passcode (local wallet is active)
  const requiresPasscode = hasWallets && activeWallet !== null;

  // Get the current address
  const address = requiresPasscode
    ? activeWallet?.address || null
    : polkadotAddress;

  // Get available signer (either from local wallet or wallet manager)
  const getAvailableSigner = useCallback((): KeyringPair | null => {
    if (requiresPasscode) {
      // For local wallet, need to unlock first
      return temporaryPair || unlockedPair || null;
    }
    // For regular wallet, use walletManager
    return walletManager?.polkadotPair || null;
  }, [requiresPasscode, temporaryPair, unlockedPair, walletManager]);

  // Request signer with passcode (for local wallet)
  const requestSigner = useCallback(
    async (passcode: string): Promise<KeyringPair | null> => {
      if (!requiresPasscode) {
        // No passcode needed, return wallet manager pair
        return walletManager?.polkadotPair || null;
      }

      // Unlock local wallet with passcode
      const pair = await unlockWallet(passcode);
      if (pair) {
        setTemporaryPair(pair);
        return pair;
      }
      return null;
    },
    [requiresPasscode, unlockWallet, walletManager]
  );

  // Clear the signer
  const clearSigner = useCallback(() => {
    setTemporaryPair(null);
    lockWallet();
  }, [lockWallet]);

  const signerPair = getAvailableSigner();
  const isReady = signerPair !== null;

  return {
    requiresPasscode,
    signerPair,
    isReady,
    address,
    requestSigner,
    getAvailableSigner,
    clearSigner,
  };
};

export default useTransactionSigner;
