"use client";

import { useState, useCallback } from "react";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import type { KeyringPair } from "@polkadot/keyring/types";

interface UseTransactionSignerReturn {
  /** Whether local wallet is being used (requires password) */
  requiresPassword: boolean;
  /** Currently loaded keypair (only available if password verified) */
  signerPair: KeyringPair | null;
  /** Whether the signer is ready to sign transactions */
  isReady: boolean;
  /** Current wallet address */
  address: string | null;
  /** Verify password and get signer */
  requestSigner: (password: string) => Promise<KeyringPair | null>;
  /** Get signer if already unlocked (for walletManager flow) */
  getAvailableSigner: () => KeyringPair | null;
  /** Clear the current signer */
  clearSigner: () => void;
}

/**
 * Hook to get a transaction signer that works with both
 * local wallets (with password) and regular wallets (from walletManager)
 */
export const useTransactionSigner = (): UseTransactionSignerReturn => {
  const { activeWallet, hasWallets, unlockWallet, unlockedPair, lockWallet } =
    useLocalWallet();
  const { walletManager, polkadotAddress } = useWalletAuth();
  const [temporaryPair, setTemporaryPair] = useState<KeyringPair | null>(null);

  // Determine if we need password (local wallet is active)
  const requiresPassword = hasWallets && activeWallet !== null;

  // Get the current address
  const address = requiresPassword
    ? activeWallet?.address || null
    : polkadotAddress;

  // Get available signer (either from local wallet or wallet manager)
  const getAvailableSigner = useCallback((): KeyringPair | null => {
    if (requiresPassword) {
      // For local wallet, need to unlock first
      return temporaryPair || unlockedPair || null;
    }
    // For regular wallet, use walletManager
    return walletManager?.polkadotPair || null;
  }, [requiresPassword, temporaryPair, unlockedPair, walletManager]);

  // Request signer with password (for local wallet)
  const requestSigner = useCallback(
    async (password: string): Promise<KeyringPair | null> => {
      if (!requiresPassword) {
        // No password needed, return wallet manager pair
        return walletManager?.polkadotPair || null;
      }

      // Unlock local wallet with password
      const pair = await unlockWallet(password);
      if (pair) {
        setTemporaryPair(pair);
        return pair;
      }
      return null;
    },
    [requiresPassword, unlockWallet, walletManager]
  );

  // Clear the signer
  const clearSigner = useCallback(() => {
    setTemporaryPair(null);
    lockWallet();
  }, [lockWallet]);

  const signerPair = getAvailableSigner();
  const isReady = signerPair !== null;

  return {
    requiresPassword,
    signerPair,
    isReady,
    address,
    requestSigner,
    getAvailableSigner,
    clearSigner,
  };
};

export default useTransactionSigner;
