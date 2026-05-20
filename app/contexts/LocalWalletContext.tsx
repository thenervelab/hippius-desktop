"use client";

import { invoke } from "@tauri-apps/api/core";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/** Mirrors `PublicLocalWallet` in `src-tauri/src/wallet/repo.rs`. */
export interface LocalWallet {
  id: number;
  name: string;
  address: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export type WalletSetupStep =
  | "loading"
  | "welcome"
  | "create-mnemonic"
  | "create-password"
  | "enter-password"
  | "import-wallet"
  | "ready";

interface LocalWalletContextValue {
  wallets: LocalWallet[];
  activeWallet: LocalWallet | null;
  isUnlocked: boolean;
  setupStep: WalletSetupStep;
  isLoading: boolean;
  hasWallets: boolean;

  generateMnemonic: () => Promise<string>;
  validateMnemonic: (mnemonic: string) => Promise<boolean>;
  deriveAddress: (mnemonic: string) => Promise<string | null>;
  createWallet: (
    name: string,
    mnemonic: string,
    password: string,
  ) => Promise<boolean>;
  importWallet: (
    name: string,
    mnemonic: string,
    password: string,
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

  unlockWallet: (password: string) => Promise<boolean>;
  unlockWalletById: (walletId: number, password: string) => Promise<boolean>;
  verifyPassword: (password: string) => Promise<boolean>;
  lockWallet: () => void;

  getDecryptedMnemonic: (password: string) => Promise<string | null>;
  getDecryptedMnemonicById: (
    walletId: number,
    password: string,
  ) => Promise<string | null>;
  exportBackup: (walletId: number) => Promise<{
    name: string;
    address: string;
    encryptedMnemonic: string;
    passwordHash: string;
    exportedAt: string;
  } | null>;

  setSetupStep: (step: WalletSetupStep) => void;
  refreshWallets: () => Promise<void>;

  truncateAddress: (address: string, start?: number, end?: number) => string;
}

const LocalWalletContext = createContext<LocalWalletContextValue | undefined>(
  undefined,
);

export function LocalWalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [wallets, setWallets] = useState<LocalWallet[]>([]);
  const [activeWallet, setActiveWallet] = useState<LocalWallet | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [setupStep, setSetupStep] = useState<WalletSetupStep>("loading");
  const [isLoading, setIsLoading] = useState(true);

  const hasWallets = wallets.length > 0;

  /** Address truncator used everywhere we render addresses inline. */
  const truncateAddress = useCallback(
    (address: string, start = 6, end = 4): string => {
      if (!address) return "";
      if (address.length <= start + end + 3) return address;
      return `${address.slice(0, start)}...${address.slice(-end)}`;
    },
    [],
  );

  const refreshWallets = useCallback(async () => {
    try {
      const [all, active] = await Promise.all([
        invoke<LocalWallet[]>("local_wallet_list"),
        invoke<LocalWallet | null>("local_wallet_get_active"),
      ]);
      setWallets(all);
      setActiveWallet(active);
    } catch (e) {
      console.error("Failed to refresh local wallets:", e);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      setIsLoading(true);
      try {
        const any = await invoke<boolean>("local_wallet_has_any");
        if (cancelled) return;
        await refreshWallets();
        if (cancelled) return;
        setSetupStep(any ? "ready" : "welcome");
      } catch (e) {
        console.error("Failed to initialise local wallets:", e);
        if (!cancelled) setSetupStep("welcome");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    init();
    return () => {
      cancelled = true;
    };
  }, [refreshWallets]);

  /* ── Mnemonic helpers ──────────────────────────────────────────────── */

  const generateMnemonic = useCallback(async (): Promise<string> => {
    return invoke<string>("local_wallet_generate_mnemonic");
  }, []);

  const validateMnemonic = useCallback(
    async (mnemonic: string): Promise<boolean> => {
      return invoke<boolean>("local_wallet_validate_mnemonic", { mnemonic });
    },
    [],
  );

  const deriveAddress = useCallback(
    async (mnemonic: string): Promise<string | null> => {
      try {
        return await invoke<string>("local_wallet_derive_address", {
          mnemonic,
        });
      } catch {
        return null;
      }
    },
    [],
  );

  /* ── Create / import ────────────────────────────────────────────────── */

  const createWallet = useCallback(
    async (
      name: string,
      mnemonic: string,
      password: string,
    ): Promise<boolean> => {
      try {
        await invoke<LocalWallet>("local_wallet_create", {
          name,
          mnemonic,
          password,
        });
        await refreshWallets();
        // User typed the password in the create flow — avoid an
        // immediate re-prompt on their first signing action.
        setIsUnlocked(true);
        setSetupStep("ready");
        return true;
      } catch (e) {
        console.error("Failed to create local wallet:", e);
        return false;
      }
    },
    [refreshWallets],
  );

  // Same Rust IPC as `createWallet`; kept as an alias so the import
  // screen reads naturally at the call site.
  const importWallet = createWallet;

  const importEncryptedWallet = useCallback(
    async (data: {
      name: string;
      address: string;
      encryptedMnemonic: string;
      passwordHash: string;
    }): Promise<boolean> => {
      try {
        await invoke<LocalWallet>("local_wallet_import_encrypted_backup", {
          name: data.name,
          address: data.address,
          encryptedMnemonic: data.encryptedMnemonic,
          passwordHash: data.passwordHash,
        });
        await refreshWallets();
        return true;
      } catch (e) {
        console.error("Failed to import encrypted local wallet:", e);
        return false;
      }
    },
    [refreshWallets],
  );

  /* ── Switching / rename / delete ────────────────────────────────────── */

  const switchWallet = useCallback(
    async (walletId: number): Promise<boolean> => {
      try {
        await invoke("local_wallet_set_active", { id: walletId });
        await refreshWallets();
        // The new active wallet has its own password; force a prompt
        // on the next signing action.
        setIsUnlocked(false);
        return true;
      } catch (e) {
        console.error("Failed to switch local wallet:", e);
        return false;
      }
    },
    [refreshWallets],
  );

  const renameWallet = useCallback(
    async (walletId: number, name: string): Promise<boolean> => {
      try {
        await invoke("local_wallet_rename", { id: walletId, name });
        await refreshWallets();
        return true;
      } catch (e) {
        console.error("Failed to rename local wallet:", e);
        return false;
      }
    },
    [refreshWallets],
  );

  const removeWallet = useCallback(
    async (walletId: number): Promise<boolean> => {
      try {
        await invoke("local_wallet_delete", { id: walletId });
        await refreshWallets();
        const remaining = await invoke<LocalWallet[]>("local_wallet_list");
        if (remaining.length === 0) {
          setIsUnlocked(false);
          setSetupStep("welcome");
        } else if (activeWallet?.id === walletId) {
          setIsUnlocked(false);
        }
        return true;
      } catch (e) {
        console.error("Failed to remove local wallet:", e);
        return false;
      }
    },
    [activeWallet],
  );

  /* ── Auth ──────────────────────────────────────────────────────────── */

  const verifyPassword = useCallback(
    async (password: string): Promise<boolean> => {
      if (!activeWallet) return false;
      try {
        return await invoke<boolean>("local_wallet_verify_password", {
          id: activeWallet.id,
          password,
        });
      } catch {
        return false;
      }
    },
    [activeWallet],
  );

  const unlockWallet = useCallback(
    async (password: string): Promise<boolean> => {
      const ok = await verifyPassword(password);
      if (ok) setIsUnlocked(true);
      return ok;
    },
    [verifyPassword],
  );

  const unlockWalletById = useCallback(
    async (walletId: number, password: string): Promise<boolean> => {
      try {
        const ok = await invoke<boolean>("local_wallet_verify_password", {
          id: walletId,
          password,
        });
        if (!ok) return false;
        await invoke("local_wallet_set_active", { id: walletId });
        await refreshWallets();
        setIsUnlocked(true);
        setSetupStep("ready");
        return true;
      } catch (e) {
        console.error("Failed to unlock local wallet by id:", e);
        return false;
      }
    },
    [refreshWallets],
  );

  const lockWallet = useCallback(() => {
    setIsUnlocked(false);
  }, []);

  /* ── Backup / recovery ─────────────────────────────────────────────── */

  const getDecryptedMnemonic = useCallback(
    async (password: string): Promise<string | null> => {
      if (!activeWallet) return null;
      try {
        return await invoke<string>("local_wallet_get_decrypted_mnemonic", {
          id: activeWallet.id,
          password,
        });
      } catch {
        return null;
      }
    },
    [activeWallet],
  );

  const getDecryptedMnemonicById = useCallback(
    async (walletId: number, password: string): Promise<string | null> => {
      try {
        return await invoke<string>("local_wallet_get_decrypted_mnemonic", {
          id: walletId,
          password,
        });
      } catch {
        return null;
      }
    },
    [],
  );

  const exportBackup = useCallback(
    async (
      walletId: number,
    ): Promise<{
      name: string;
      address: string;
      encryptedMnemonic: string;
      passwordHash: string;
      exportedAt: string;
    } | null> => {
      try {
        return await invoke("local_wallet_export_backup", { id: walletId });
      } catch (e) {
        console.error("Failed to export wallet backup:", e);
        return null;
      }
    },
    [],
  );

  const value = useMemo(
    () => ({
      wallets,
      activeWallet,
      isUnlocked,
      setupStep,
      isLoading,
      hasWallets,
      generateMnemonic,
      validateMnemonic,
      deriveAddress,
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
      getDecryptedMnemonic,
      getDecryptedMnemonicById,
      exportBackup,
      setSetupStep,
      refreshWallets,
      truncateAddress,
    }),
    [
      wallets,
      activeWallet,
      isUnlocked,
      setupStep,
      isLoading,
      hasWallets,
      generateMnemonic,
      validateMnemonic,
      deriveAddress,
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
      getDecryptedMnemonic,
      getDecryptedMnemonicById,
      exportBackup,
      refreshWallets,
      truncateAddress,
    ],
  );

  return (
    <LocalWalletContext.Provider value={value}>
      {children}
    </LocalWalletContext.Provider>
  );
}

export function useLocalWallet(): LocalWalletContextValue {
  const ctx = useContext(LocalWalletContext);
  if (ctx === undefined) {
    throw new Error("useLocalWallet must be used within a LocalWalletProvider");
  }
  return ctx;
}
