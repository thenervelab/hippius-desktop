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

/* Local-wallet context.
 *
 * Ported from `feature/wallet-updates`. The original implementation kept
 * persistence (sql.js), crypto (CryptoJS), and key derivation
 * (`@polkadot/keyring`) in TypeScript. Per CLAUDE.md we keep all of that
 * in Rust — this file is now a thin React shell over the
 * `local_wallet_*` Tauri IPCs added in `src-tauri/src/wallet/commands.rs`.
 *
 * Key shape differences from the legacy TS implementation:
 *   - There is no `KeyringPair` in TS anymore. The unlocked keypair lives
 *     in Rust (after Step 6 of the port). For now we just track an
 *     "is unlocked" boolean derived from whether the user recently
 *     verified their password.
 *   - `signTransaction(password)` no longer returns a Polkadot pair; it
 *     returns a boolean indicating whether the password was accepted.
 *     Each signing IPC (transfer_balance, stake_bond, etc.) will take
 *     the password directly in Step 6 — until then signing still flows
 *     through the existing auth session mnemonic and this surface is
 *     not yet wired to it.
 */

/** A wallet record as returned by the Rust IPC. Mirrors
 *  `PublicLocalWallet` in `src-tauri/src/wallet/repo.rs`. */
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
  | "welcome"          // No wallet yet — show create/import prompt
  | "create-mnemonic"  // Show generated mnemonic to the user
  | "create-password"  // Set password for the wallet being created
  | "enter-password"   // (unused for now) — kept for parity with legacy flow
  | "import-wallet"    // Paste an existing mnemonic
  | "ready";           // At least one wallet exists; FE can browse it

interface LocalWalletContextValue {
  // State
  wallets: LocalWallet[];
  activeWallet: LocalWallet | null;
  isUnlocked: boolean;
  setupStep: WalletSetupStep;
  isLoading: boolean;
  hasWallets: boolean;

  // Wallet management
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

  // Authentication
  unlockWallet: (password: string) => Promise<boolean>;
  unlockWalletById: (walletId: number, password: string) => Promise<boolean>;
  verifyPassword: (password: string) => Promise<boolean>;
  lockWallet: () => void;

  // Backup / recovery
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

  // Navigation
  setSetupStep: (step: WalletSetupStep) => void;
  refreshWallets: () => Promise<void>;

  // Utilities
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

  // Initial load — decides whether to drop the user into the onboarding
  // flow (welcome) or into the regular wallet UI (ready).
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
        // The user just typed the password — treat them as unlocked so the
        // next signing action doesn't re-prompt for it immediately.
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

  // Import is functionally identical to create from Rust's perspective —
  // both call `local_wallet_create`. Kept as a separate function so the
  // import-from-mnemonic onboarding screen reads naturally.
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
        // Switching wallets invalidates the previous unlocked state — the
        // new active wallet has its own password.
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
