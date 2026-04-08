"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { saveHcfsConfig } from "@/lib/utils/hcfsConfigUtils";
import { syncEngineStatusAtom, isSyncConfiguredAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { migrationCheckAtom, migrationLockAtom, migrationProgressAtom } from "@/lib/global-atoms/migrationAtoms";
import { appStore } from "@/lib/store/jotaiStore";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

export type MigrationStep = "prompt" | "skip-confirm" | "setup" | "complete";

interface MigrationCheckResult {
  needs_migration: boolean;
  file_count: number;
  total_size: number;
  sync_path: string | null;
  is_resuming: boolean;
  needs_completion: boolean;
  completion_status: string | null;
  is_in_progress: boolean;
  progress_completed: number;
  progress_total: number;
  progress_failed: number;
}

interface PollMigrationStatusResult {
  status: string;
  total: number;
  completed: number;
  failed: number;
  failed_files: string[];
  current_file: string | null;
  should_warn: boolean;
  should_abort: boolean;
  is_terminal: boolean;
}

export interface UseMigrationReturn {
  currentStep: MigrationStep | null;
  setCurrentStep: (step: MigrationStep | null) => void;
  fileCount: number;
  successCount: number;
  failedCount: number;
  failedFiles: Array<{ name: string; error: string }>;
  totalSize: number;
  isResuming: boolean;
  migrationSucceeded: boolean;
  transitionError: string | null;
  checkMigration: (accountId: string) => Promise<boolean>;
  startMigration: (accountId: string) => Promise<void>;
  onSetupComplete: (result: { serverUrl: string; password: string }) => Promise<void>;
  isSettingUp: boolean;
  confirmSkip: () => Promise<void>;
  closeMigration: () => Promise<void>;
  dismissAfterError: () => void;
}

export function useMigration(): UseMigrationReturn {
  const { authType } = useWalletAuth();
  const [currentStep, setCurrentStep] = useState<MigrationStep | null>(null);
  const [totalSize, setTotalSize] = useState(0);
  const [fileCount, setFileCount] = useState(0);
  const [isResuming, setIsResuming] = useState(false);

  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null);
  const [isSettingUp, setIsSettingUp] = useState(false);

  const activeAccountIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const [successCount, setSuccessCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [failedFiles, setFailedFiles] = useState<
    Array<{ name: string; error: string }>
  >([]);
  const [migrationSucceeded, setMigrationSucceeded] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
      invoke("stop_migration_polling").catch(() => {});
    };
  }, []);

  const stopPolling = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    invoke("stop_migration_polling").catch(() => {});
  }, []);

  const startPolling = useCallback(
    async (accountId: string) => {
      stopPolling();

      const unlisten = await listen<PollMigrationStatusResult>("migration_progress", (event) => {
        const result = event.payload;

        if (result.should_warn) {
          toast.warning("Having trouble checking migration status. Retrying...");
        }
        if (result.should_abort) {
          stopPolling();
          toast.error("Lost connection to migration server. Please check your network and try again.");
          appStore.set(migrationLockAtom, false);
          appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0, failed: 0 });
          setMigrationSucceeded(false);
          setCurrentStep("complete");
          return;
        }
        if (result.status === "poll_error") return;

        setSuccessCount(result.completed);
        setFailedCount(result.failed);

        appStore.set(migrationProgressAtom, {
          active: true,
          completed: result.completed,
          total: result.total,
          failed: result.failed,
        });

        if (result.failed_files.length > 0) {
          setFailedFiles(
            result.failed_files.map((name) => ({
              name,
              error: "Migration failed on server",
            }))
          );
        }

        if (result.is_terminal) {
          stopPolling();
          setMigrationSucceeded(result.status === "completed");
          setCurrentStep("complete");
          appStore.set(migrationLockAtom, false);
          appStore.set(migrationProgressAtom, {
            active: false,
            completed: result.completed,
            total: result.total,
            failed: result.failed,
          });
        }
      });
      unlistenRef.current = unlisten;

      await invoke("start_migration_polling", { accountId });
    },
    [stopPolling]
  );

  const checkMigration = useCallback(
    async (accountId: string): Promise<boolean> => {
      appStore.set(migrationCheckAtom, {
        ...appStore.get(migrationCheckAtom),
        shouldCheck: false,
      });
      try {
        const result = await invoke<MigrationCheckResult>(
          "check_migration",
          { accountId }
        );

        if (result.needs_completion) {
          setFileCount(result.file_count);
          setSuccessCount(result.progress_completed);
          setFailedCount(result.progress_failed);
          setMigrationSucceeded(result.completion_status === "completed");
          activeAccountIdRef.current = accountId;
          setCurrentStep("complete");
          return true;
        }

        // Server migration actively running — show banner and start polling
        if (result.is_in_progress) {
          appStore.set(migrationProgressAtom, {
            active: true,
            completed: result.progress_completed,
            total: result.progress_total,
            failed: result.progress_failed,
          });
          appStore.set(migrationLockAtom, true);
          activeAccountIdRef.current = accountId;
          startPolling(accountId);
          return true;
        }

        if (result.needs_migration) {
          setFileCount(result.file_count);
          setTotalSize(result.total_size);
          setIsResuming(result.is_resuming);
          setCurrentStep("prompt");
          activeAccountIdRef.current = accountId;
          return true;
        }
        return false;
      } catch (err) {
        console.error("[Migration] Check failed:", err);
        return false;
      }
    },
    [startPolling]
  );

  const launchServerMigration = useCallback(
    async (accountId: string) => {
      setSuccessCount(0);
      setFailedCount(0);
      setFailedFiles([]);
      setMigrationSucceeded(false);

      appStore.set(migrationLockAtom, true);

      try {
        await invoke("start_server_migration", { accountId, totalSize });

        // Dismiss any open dialogs and activate the banner
        setCurrentStep(null);
        appStore.set(migrationProgressAtom, {
          active: true,
          completed: 0,
          total: fileCount,
          failed: 0,
        });

        startPolling(accountId);
      } catch (err) {
        console.error("[Migration] Start failed:", err);
        appStore.set(migrationLockAtom, false);
        // Structural dispatch on AppError.kind from Rust.
        const kind = (err as { kind?: string } | null)?.kind;
        if (kind === "NotReady") {
          const message = (err as { message?: string }).message ?? "";
          if (message.includes("Not enough disk space")) {
            toast.error("Not enough disk space for migration. Please free up space and try again.");
          } else if (message.includes("Master mnemonic")) {
            if (authType === "oauth") {
              toast.error(
                "Migration setup incomplete. Please complete sync setup before starting migration, or contact support if the problem persists."
              );
            } else {
              toast.error(
                "Seed phrase not available. Please log out and log back in with your seed phrase to start migration."
              );
            }
          } else {
            toast.error("Failed to start migration. Please try again.");
          }
        } else {
          toast.error("Failed to start migration. Please try again.");
        }
        setCurrentStep("prompt");
      }
    },
    [totalSize, fileCount, startPolling, authType]
  );

  const startMigration = useCallback(
    async (accountId: string) => {
      const flow = await invoke<{ nextStep: string }>("start_migration_flow", { accountId });
      if (flow.nextStep === "setup") {
        setPendingAccountId(accountId);
        setCurrentStep("setup");
        return;
      }
      await launchServerMigration(accountId);
    },
    [launchServerMigration]
  );

  const onSetupComplete = useCallback(
    async (result: { serverUrl: string; password: string }) => {
      if (!pendingAccountId) return;
      setIsSettingUp(true);

      try {
        await saveHcfsConfig(pendingAccountId, result.serverUrl, result.password);
        setIsSettingUp(false);
        await launchServerMigration(pendingAccountId);
      } catch (err) {
        console.error("[Migration] Setup failed:", err);
        setIsSettingUp(false);
        setCurrentStep("prompt");
      }
    },
    [pendingAccountId, launchServerMigration]
  );

  const confirmSkip = useCallback(async () => {
    try {
      const accountId = activeAccountIdRef.current;
      if (accountId) {
        await invoke("dismiss_migration", {
          accountId,
          reason: "skipped",
        });
      }
      toast.success("Started fresh! Your S3 files have been skipped and won't be migrated.");
    } catch (err) {
      console.error("[Migration] Dismiss (skip) failed:", err);
      toast.error("Failed to save your choice. Please try again.");
    }
    appStore.set(migrationCheckAtom, {
      checked: true,
      needsMigration: false,
      fileCount: 0,
      totalSize: 0,
      shouldCheck: false,
    });
    appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0, failed: 0 });
    setCurrentStep(null);
  }, []);

  const closeMigration = useCallback(async () => {
    const accountId = activeAccountIdRef.current;
    stopPolling();
    setTransitionError(null);
    setCurrentStep(null);

    if (accountId) {
      try {
        await invoke("complete_migration_transition", { accountId });
        appStore.set(syncEngineStatusAtom, "active");
        appStore.set(isSyncConfiguredAtom, true);
      } catch (err) {
        console.error("[Migration] complete_migration_transition failed:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        setTransitionError(errorMsg);
        setCurrentStep("complete");
        toast.error("Failed to set up file sync after migration. You can set it up later from Settings.");
        return;
      }
    }

    appStore.set(migrationLockAtom, false);
    appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0, failed: 0 });
    appStore.set(migrationCheckAtom, {
      checked: true,
      needsMigration: false,
      fileCount: 0,
      totalSize: 0,
      shouldCheck: false,
    });
    setCurrentStep(null);
    setSuccessCount(0);
    setFailedCount(0);
    setFailedFiles([]);
    setTotalSize(0);
    setFileCount(0);
    setIsResuming(false);
    setMigrationSucceeded(false);
    setTransitionError(null);
    setPendingAccountId(null);
    setIsSettingUp(false);
    activeAccountIdRef.current = null;
  }, [stopPolling]);

  const dismissAfterError = useCallback(() => {
    appStore.set(migrationLockAtom, false);
    appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0, failed: 0 });
    appStore.set(migrationCheckAtom, {
      checked: true,
      needsMigration: false,
      fileCount: 0,
      totalSize: 0,
      shouldCheck: false,
    });
    setCurrentStep(null);
    setTransitionError(null);
  }, []);

  return {
    currentStep,
    setCurrentStep,
    fileCount,
    successCount,
    failedCount,
    failedFiles,
    totalSize,
    isResuming,
    migrationSucceeded,
    transitionError,
    checkMigration,
    startMigration,
    onSetupComplete,
    isSettingUp,
    confirmSkip,
    closeMigration,
    dismissAfterError,
  };
}
