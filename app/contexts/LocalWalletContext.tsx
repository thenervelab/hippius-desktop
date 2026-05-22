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
import { useWalletAuth } from "@/lib/wallet-auth-context";

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
  /** Returns the raw bytes of a `.zip` archive containing the
      wallet's encrypted backup JSON. Caller is responsible for
      saving to disk; null on IPC failure. */
  exportBackupZip: (walletId: number) => Promise<Uint8Array | null>;
  /** Import a wallet from a `.zip` archive produced by
      `exportBackupZip`. The user-supplied `name` overrides whatever
      label the file carries, matching the JSON import path. */
  importEncryptedWalletFromZip: (data: {
    name: string;
    zipBytes: Uint8Array;
  }) => Promise<boolean>;

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
  // Wallets are scoped to the logged-in account in Rust (`local_wallets.owner`
  // mirrors `sync_paths.owner`). Subscribing to `polkadotAddress` here lets
  // the FE swap the visible wallet list when the user logs in/out or signs
  // in as a different account on the same machine.
  const { polkadotAddress } = useWalletAuth();
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
    // Skip the IPC roundtrip when nobody is logged in — the Rust commands
    // would reject with "Log in to manage local wallets" and we'd log a
    // useless error every time anything bumped the dep.
    if (!polkadotAddress) {
      setWallets([]);
      setActiveWallet(null);
      return;
    }
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
  }, [polkadotAddress]);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      // Logged-out state: wipe the FE mirror immediately so a previous
      // account's wallets don't flash visible during the next login.
      // Unlock state must reset too — a stale `isUnlocked=true` from the
      // previous session would otherwise bypass the password prompt on
      // the next signing action.
      if (!polkadotAddress) {
        if (cancelled) return;
        setWallets([]);
        setActiveWallet(null);
        setIsUnlocked(false);
        setSetupStep("welcome");
        setIsLoading(false);
        return;
      }
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
  }, [polkadotAddress, refreshWallets]);

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

  const exportBackupZip = useCallback(
    async (walletId: number): Promise<Uint8Array | null> => {
      try {
        // Tauri serialises Vec<u8> as `number[]` over IPC; we normalise
        // to Uint8Array here so the caller can hand it straight to
        // `writeFile`. The zip-bytes branch is opted into by callers
        // that need the binary archive (export-as-zip flow) — the
        // existing struct-returning `exportBackup` stays as-is so the
        // tests + any FE code that wants the parsed payload still work.
        const bytes = await invoke<number[]>("local_wallet_export_backup_zip", {
          id: walletId,
        });
        return new Uint8Array(bytes);
      } catch (e) {
        console.error("Failed to export wallet backup zip:", e);
        return null;
      }
    },
    [],
  );

  const importEncryptedWalletFromZip = useCallback(
    async (data: {
      name: string;
      zipBytes: Uint8Array;
    }): Promise<boolean> => {
      try {
        // Tauri's IPC serialiser accepts `number[]` for Vec<u8>; the
        // Array.from copy keeps the existing buffer untouched.
        await invoke<LocalWallet>(
          "local_wallet_import_encrypted_backup_from_zip",
          {
            name: data.name,
            zipBytes: Array.from(data.zipBytes),
          },
        );
        await refreshWallets();
        return true;
      } catch (e) {
        console.error("Failed to import wallet from zip:", e);
        return false;
      }
    },
    [refreshWallets],
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
      exportBackupZip,
      importEncryptedWalletFromZip,
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
      exportBackupZip,
      importEncryptedWalletFromZip,
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
