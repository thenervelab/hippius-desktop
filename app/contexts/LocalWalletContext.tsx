"use client";

import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { bridgeInFlightAtom } from "@/lib/global-atoms/bridgeAtoms";

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
    /** User-typed password. The Rust IPC verifies it against the
     *  backup's `passwordHash` (constant-time SHA-256 compare) and
     *  refuses the import on mismatch — guards against importing a
     *  wallet under the wrong password, which would only surface as
     *  a confusing "Incorrect password" on the next signing attempt. */
    password: string;
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
  exportBackup: (walletId: number, password: string) => Promise<{
    name: string;
    address: string;
    encryptedMnemonic: string;
    passwordHash: string;
    exportedAt: string;
  } | null>;
  /** Returns the raw bytes of a `.zip` archive containing the
      wallet's encrypted backup JSON. Requires the wallet password
      (the backend gates export, audit R-07). Caller saves to disk;
      null on a wrong password or IPC failure. */
  exportBackupZip: (walletId: number, password: string) => Promise<Uint8Array | null>;
  /** Import a wallet from a `.zip` archive produced by
      `exportBackupZip`. The user-supplied `name` overrides whatever
      label the file carries, matching the JSON import path. */
  importEncryptedWalletFromZip: (data: {
    name: string;
    zipBytes: Uint8Array;
    /** User-typed password. Verified Rust-side against the hash
     *  carried inside the zip (same constant-time check as the
     *  JSON path). Import is rejected on mismatch. */
    password: string;
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
      if (address.length <= start + end + 1) return address;
      // Unicode horizontal ellipsis renders as one clean glyph instead
      // of three ASCII periods, which crush together in narrow / mono /
      // uppercase contexts (the active-wallet pill shows "5HKT.WWDB"
      // instead of "5HKT...WWDB" because Geist Mono kerns "..." tightly
      // at 12px).
      return `${address.slice(0, start)}…${address.slice(-end)}`;
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
      password: string;
    }): Promise<boolean> => {
      try {
        await invoke<LocalWallet>("local_wallet_import_encrypted_backup", {
          name: data.name,
          address: data.address,
          encryptedMnemonic: data.encryptedMnemonic,
          passwordHash: data.passwordHash,
          password: data.password,
        });
        await refreshWallets();
        return true;
      } catch (e) {
        // Rethrow so the import screen can surface "Incorrect password"
        // from Rust instead of swallowing it into a generic failure.
        console.error("Failed to import encrypted local wallet:", e);
        throw e;
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

  /* ── Idle auto-lock ──────────────────────────────────────────────────
   *
   * The wallet "unlocked" flag is a soft FE gate — every signing flow
   * (Send / Stake / Unstake / Withdraw / Bridge) re-prompts for the
   * password and re-derives the keypair in Rust, so there's no
   * long-lived secret in renderer memory for an idle attacker to
   * grab. Auto-lock here is mostly UX-defensive: if the laptop is
   * left unattended after the user viewed their recovery phrase, the
   * next user-action requiring "unlocked" state should re-prompt.
   *
   * Timeline: 5 min of idle (no successful unlock-refreshing call)
   * → flip isUnlocked back to false. The user can re-unlock with the
   * usual password prompt; the timer resets on every
   * `setIsUnlocked(true)` (handled by the watcher below).
   *
   * Pause condition: when a bridge submit is in progress
   * (`bridgeInFlight > 0`), the timer is suspended. A multi-step
   * bridge can legitimately take longer than the idle window
   * (slow testnet block production + several signs), and silently
   * flipping the soft-lock during the user's "watch the wizard
   * tick" experience is confusing. The bridge submit closure holds
   * its password independently so signing continues either way —
   * pausing the timer is purely a UX correctness fix.
   */
  const IDLE_LOCK_MS = 5 * 60 * 1000;
  const bridgeInFlight = useAtomValue(bridgeInFlightAtom);
  useEffect(() => {
    if (!isUnlocked) return;
    if (bridgeInFlight > 0) return;
    const t = window.setTimeout(() => {
      setIsUnlocked(false);
    }, IDLE_LOCK_MS);
    return () => window.clearTimeout(t);
    // Re-arm the timer every time the unlocked state flips to true,
    // and re-evaluate the pause-during-bridge condition when the
    // in-flight count changes (so the timer restarts as soon as a
    // bridge submit settles, not after the next isUnlocked toggle).
  }, [isUnlocked, IDLE_LOCK_MS, bridgeInFlight]);

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
      password: string,
    ): Promise<{
      name: string;
      address: string;
      encryptedMnemonic: string;
      passwordHash: string;
      exportedAt: string;
    } | null> => {
      try {
        return await invoke("local_wallet_export_backup", { id: walletId, password });
      } catch (e) {
        console.error("Failed to export wallet backup:", e);
        return null;
      }
    },
    [],
  );

  const exportBackupZip = useCallback(
    async (walletId: number, password: string): Promise<Uint8Array | null> => {
      try {
        // Tauri serialises Vec<u8> as `number[]` over IPC; we normalise
        // to Uint8Array here so the caller can hand it straight to
        // `writeFile`. The backend requires the wallet password (audit
        // R-07); a wrong password surfaces as a thrown IPC error which we
        // swallow to `null` so the export dialog shows a retry message.
        const bytes = await invoke<number[]>("local_wallet_export_backup_zip", {
          id: walletId,
          password,
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
      password: string;
    }): Promise<boolean> => {
      try {
        // Tauri's IPC serialiser accepts `number[]` for Vec<u8>; the
        // Array.from copy keeps the existing buffer untouched.
        await invoke<LocalWallet>(
          "local_wallet_import_encrypted_backup_from_zip",
          {
            name: data.name,
            zipBytes: Array.from(data.zipBytes),
            password: data.password,
          },
        );
        await refreshWallets();
        return true;
      } catch (e) {
        // Rethrow so the import screen can surface "Incorrect password"
        // (or whatever the Rust error says) instead of a generic
        // "Failed to import wallet" toast.
        console.error("Failed to import wallet from zip:", e);
        throw e;
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
