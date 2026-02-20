"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";
import {
  LocalWallet,
  getAllLocalWallets,
  getActiveLocalWallet,
  createLocalWallet,
  setActiveWallet as setActiveWalletDb,
  deleteLocalWallet,
  hasLocalWallets,
  updateWalletName,
  getLocalWalletById,
  importWalletFromEncryptedBackup,
} from "@/app/lib/helpers/localWalletDb";
import {
  hashPassword,
  encryptMnemonic,
  decryptMnemonic,
} from "@/app/lib/helpers/crypto";
import { isMnemonicValid } from "@/app/lib/helpers/validateMnemonic";
import type { KeyringPair } from "@polkadot/keyring/types";

// Re-export LocalWallet type for consumers
export type { LocalWallet } from "@/app/lib/helpers/localWalletDb";

/* ── Types ─────────────────────────────── */

export type WalletSetupStep =
  | "loading"
  | "welcome" // Initial screen - enter mnemonic or create/import
  | "create-mnemonic" // Show generated mnemonic
  | "create-password" // Set password for new wallet
  | "enter-password" // Enter password for existing wallet
  | "import-wallet" // Import wallet from file
  | "ready"; // Wallet unlocked and ready

interface LocalWalletContextValue {
  // State
  wallets: LocalWallet[];
  activeWallet: LocalWallet | null;
  unlockedPair: KeyringPair | null;
  setupStep: WalletSetupStep;
  isLoading: boolean;
  hasWallets: boolean;

  // Wallet management
  generateMnemonic: () => string;
  createWallet: (
    name: string,
    mnemonic: string,
    password: string
  ) => Promise<boolean>;
  importWallet: (
    name: string,
    mnemonic: string,
    password: string
  ) => Promise<boolean>;
  importEncryptedWallet: (data: {
    name: string;
    address: string;
    encryptedMnemonic: string;
    passwordHash: string;
  }) => Promise<boolean>;
  switchWallet: (walletId: number) => Promise<boolean>;
  renameWallet: (walletId: number, name: string) => Promise<boolean>;
  removeWallet: (walletId: number) => Promise<boolean>;

  // Authentication
  unlockWallet: (password: string) => Promise<KeyringPair | null>;
  unlockWalletById: (walletId: number, password: string) => Promise<KeyringPair | null>;
  verifyPassword: (password: string) => boolean;
  lockWallet: () => void;

  // Transaction signing
  signTransaction: (password: string) => Promise<KeyringPair | null>;

  // Navigation
  setSetupStep: (step: WalletSetupStep) => void;
  refreshWallets: () => Promise<void>;

  // Utilities
  truncateAddress: (address: string, start?: number, end?: number) => string;
  getDecryptedMnemonic: (password: string) => string | null;
  getDecryptedMnemonicById: (walletId: number, password: string) => Promise<string | null>;
}

const LocalWalletContext = createContext<LocalWalletContextValue | undefined>(
  undefined
);

/* ── Provider ─────────────────────────────── */

export function LocalWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [wallets, setWallets] = useState<LocalWallet[]>([]);
  const [activeWallet, setActiveWallet] = useState<LocalWallet | null>(null);
  const [unlockedPair, setUnlockedPair] = useState<KeyringPair | null>(null);
  const [setupStep, setSetupStep] = useState<WalletSetupStep>("loading");
  const [isLoading, setIsLoading] = useState(true);
  const [_cachedPassword, setCachedPassword] = useState<string | null>(null);

  // Check if there are any wallets
  const hasWallets = wallets.length > 0;

  // Truncate address helper
  const truncateAddress = useCallback(
    (address: string, start = 6, end = 4): string => {
      if (!address) return "";
      if (address.length <= start + end + 3) return address;
      return `${address.slice(0, start)}...${address.slice(-end)}`;
    },
    []
  );

  // Generate a new mnemonic
  const generateMnemonic = useCallback((): string => {
    return mnemonicGenerate(12);
  }, []);

  // Refresh wallets from database
  const refreshWallets = useCallback(async () => {
    try {
      const allWallets = await getAllLocalWallets();
      setWallets(allWallets);

      const active = await getActiveLocalWallet();
      setActiveWallet(active);
    } catch (error) {
      console.error("Failed to refresh wallets:", error);
    }
  }, []);

  // Initialize on mount
  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      try {
        await cryptoWaitReady();

        const hasAnyWallets = await hasLocalWallets();
        await refreshWallets();

        if (hasAnyWallets) {
          // User has wallet(s) - go directly to ready state
          // They can view wallet info without unlocking
          // Password will be required only for signing transactions
          setSetupStep("ready");
        } else {
          // No wallet exists - show setup flow
          setSetupStep("welcome");
        }
      } catch (error) {
        console.error("Failed to initialize local wallet:", error);
        setSetupStep("welcome");
      } finally {
        setIsLoading(false);
      }
    };

    init();
  }, [refreshWallets]);

  // Create a new wallet
  const createWallet = useCallback(
    async (
      name: string,
      mnemonic: string,
      password: string
    ): Promise<boolean> => {
      try {
        if (!isMnemonicValid(mnemonic)) {
          throw new Error("Invalid mnemonic");
        }

        const passwordHash = hashPassword(password);
        const encrypted = encryptMnemonic(mnemonic, password);

        await createLocalWallet({
          name,
          mnemonic,
          encryptedMnemonic: encrypted,
          passwordHash,
        });

        await refreshWallets();

        // Unlock the wallet
        await cryptoWaitReady();
        const keyring = new Keyring({ type: "sr25519" });
        const pair = keyring.addFromMnemonic(mnemonic);
        setUnlockedPair(pair);
        setCachedPassword(password);
        setSetupStep("ready");

        return true;
      } catch (error) {
        console.error("Failed to create wallet:", error);
        return false;
      }
    },
    [refreshWallets]
  );

  // Import an existing wallet
  const importWallet = useCallback(
    async (
      name: string,
      mnemonic: string,
      password: string
    ): Promise<boolean> => {
      try {
        if (!isMnemonicValid(mnemonic)) {
          throw new Error("Invalid mnemonic");
        }

        const passwordHash = hashPassword(password);
        const encrypted = encryptMnemonic(mnemonic, password);

        await createLocalWallet({
          name,
          mnemonic,
          encryptedMnemonic: encrypted,
          passwordHash,
        });

        await refreshWallets();

        // Unlock the wallet
        await cryptoWaitReady();
        const keyring = new Keyring({ type: "sr25519" });
        const pair = keyring.addFromMnemonic(mnemonic);
        setUnlockedPair(pair);
        setCachedPassword(password);
        setSetupStep("ready");

        return true;
      } catch (error) {
        console.error("Failed to import wallet:", error);
        return false;
      }
    },
    [refreshWallets]
  );

  // Import wallet from encrypted backup (preserves original encryption)
  const importEncryptedWallet = useCallback(
    async (data: {
      name: string;
      address: string;
      encryptedMnemonic: string;
      passwordHash: string;
    }): Promise<boolean> => {
      try {
        await importWalletFromEncryptedBackup(data);
        await refreshWallets();
        return true;
      } catch (error) {
        console.error("Failed to import encrypted wallet:", error);
        return false;
      }
    },
    [refreshWallets]
  );

  // Unlock wallet with password
  const unlockWallet = useCallback(
    async (password: string): Promise<KeyringPair | null> => {
      try {
        if (!activeWallet) {
          return null;
        }

        const passwordHash = hashPassword(password);
        if (passwordHash !== activeWallet.passwordHash) {
          return null;
        }

        const mnemonic = decryptMnemonic(
          activeWallet.encryptedMnemonic,
          password
        );
        if (!isMnemonicValid(mnemonic)) {
          return null;
        }

        await cryptoWaitReady();
        const keyring = new Keyring({ type: "sr25519" });
        const pair = keyring.addFromMnemonic(mnemonic);
        setUnlockedPair(pair);
        setCachedPassword(password);

        return pair;
      } catch (error) {
        console.error("Failed to unlock wallet:", error);
        return null;
      }
    },
    [activeWallet]
  );

  // Unlock a specific wallet by ID
  const unlockWalletById = useCallback(
    async (walletId: number, password: string): Promise<KeyringPair | null> => {
      try {
        const wallet = await getLocalWalletById(walletId);
        if (!wallet) return null;

        const passwordHash = hashPassword(password);
        if (passwordHash !== wallet.passwordHash) {
          return null;
        }

        const mnemonic = decryptMnemonic(wallet.encryptedMnemonic, password);
        if (!isMnemonicValid(mnemonic)) {
          return null;
        }

        // Set as active
        await setActiveWalletDb(walletId);
        await refreshWallets();

        await cryptoWaitReady();
        const keyring = new Keyring({ type: "sr25519" });
        const pair = keyring.addFromMnemonic(mnemonic);
        setUnlockedPair(pair);
        setCachedPassword(password);
        setSetupStep("ready");

        return pair;
      } catch (error) {
        console.error("Failed to unlock wallet by ID:", error);
        return null;
      }
    },
    [refreshWallets]
  );

  // Verify password for current active wallet
  const verifyPassword = useCallback(
    (password: string): boolean => {
      if (!activeWallet) return false;
      const passwordHash = hashPassword(password);
      return passwordHash === activeWallet.passwordHash;
    },
    [activeWallet]
  );

  // Lock wallet (clear cached keypair but stay on dashboard)
  const lockWallet = useCallback(() => {
    setUnlockedPair(null);
    setCachedPassword(null);
    // Don't change setupStep - user can still view dashboard without password
    // Password will be requested again when signing next transaction
  }, []);

  // Get the keypair for signing transactions
  const signTransaction = useCallback(
    async (password: string): Promise<KeyringPair | null> => {
      try {
        if (!activeWallet) return null;

        const passwordHash = hashPassword(password);
        if (passwordHash !== activeWallet.passwordHash) {
          return null;
        }

        const mnemonic = decryptMnemonic(
          activeWallet.encryptedMnemonic,
          password
        );
        if (!isMnemonicValid(mnemonic)) {
          return null;
        }

        await cryptoWaitReady();
        const keyring = new Keyring({ type: "sr25519" });
        return keyring.addFromMnemonic(mnemonic);
      } catch (error) {
        console.error("Failed to sign transaction:", error);
        return null;
      }
    },
    [activeWallet]
  );

  // Switch to a different wallet
  const switchWallet = useCallback(
    async (walletId: number): Promise<boolean> => {
      try {
        await setActiveWalletDb(walletId);
        await refreshWallets();

        // Clear cached keypair for the previous wallet
        // User stays on dashboard - password only needed for signing
        setUnlockedPair(null);
        setCachedPassword(null);

        return true;
      } catch (error) {
        console.error("Failed to switch wallet:", error);
        return false;
      }
    },
    [refreshWallets]
  );

  // Rename a wallet
  const renameWallet = useCallback(
    async (walletId: number, name: string): Promise<boolean> => {
      try {
        await updateWalletName(walletId, name);
        await refreshWallets();
        return true;
      } catch (error) {
        console.error("Failed to rename wallet:", error);
        return false;
      }
    },
    [refreshWallets]
  );

  // Remove a wallet
  const removeWallet = useCallback(
    async (walletId: number): Promise<boolean> => {
      try {
        await deleteLocalWallet(walletId);
        await refreshWallets();

        // If no wallets left, go to welcome screen
        const remaining = await getAllLocalWallets();
        if (remaining.length === 0) {
          setUnlockedPair(null);
          setCachedPassword(null);
          setSetupStep("welcome");
        } else if (activeWallet?.id === walletId) {
          // Deleted the active wallet - clear keypair, stay on dashboard
          setUnlockedPair(null);
          setCachedPassword(null);
          // setupStep stays "ready" - remaining wallets are viewable without password
        }

        return true;
      } catch (error) {
        console.error("Failed to remove wallet:", error);
        return false;
      }
    },
    [activeWallet, refreshWallets]
  );

  // Get decrypted mnemonic (for export)
  const getDecryptedMnemonic = useCallback(
    (password: string): string | null => {
      if (!activeWallet) return null;

      try {
        const passwordHash = hashPassword(password);
        if (passwordHash !== activeWallet.passwordHash) {
          return null;
        }

        const mnemonic = decryptMnemonic(
          activeWallet.encryptedMnemonic,
          password
        );
        if (!isMnemonicValid(mnemonic)) {
          return null;
        }

        return mnemonic;
      } catch {
        return null;
      }
    },
    [activeWallet]
  );

  // Get decrypted mnemonic by wallet ID (for exporting any wallet)
  const getDecryptedMnemonicById = useCallback(
    async (walletId: number, password: string): Promise<string | null> => {
      try {
        const wallet = wallets.find((w) => w.id === walletId);
        if (!wallet) return null;

        const passwordHash = hashPassword(password);
        if (passwordHash !== wallet.passwordHash) {
          return null;
        }

        const mnemonic = decryptMnemonic(wallet.encryptedMnemonic, password);
        if (!isMnemonicValid(mnemonic)) {
          return null;
        }

        return mnemonic;
      } catch {
        return null;
      }
    },
    [wallets]
  );

  const value = useMemo(
    () => ({
      wallets,
      activeWallet,
      unlockedPair,
      setupStep,
      isLoading,
      hasWallets,
      generateMnemonic,
      createWallet,
      importWallet,
      importEncryptedWallet,
      switchWallet,
      renameWallet,
      removeWallet,
      unlockWallet,
      unlockWalletById,
      verifyPassword,
      lockWallet,
      signTransaction,
      setSetupStep,
      refreshWallets,
      truncateAddress,
      getDecryptedMnemonic,
      getDecryptedMnemonicById,
    }),
    [
      wallets,
      activeWallet,
      unlockedPair,
      setupStep,
      isLoading,
      hasWallets,
      generateMnemonic,
      createWallet,
      importWallet,
      importEncryptedWallet,
      switchWallet,
      renameWallet,
      removeWallet,
      unlockWallet,
      unlockWalletById,
      verifyPassword,
      lockWallet,
      signTransaction,
      refreshWallets,
      truncateAddress,
      getDecryptedMnemonic,
      getDecryptedMnemonicById,
    ]
  );

  return (
    <LocalWalletContext.Provider value={value}>
      {children}
    </LocalWalletContext.Provider>
  );
}

/* ── Hook ─────────────────────────────── */

export function useLocalWallet() {
  const context = useContext(LocalWalletContext);
  if (context === undefined) {
    throw new Error("useLocalWallet must be used within a LocalWalletProvider");
  }
  return context;
}

export default LocalWalletContext;
