"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { errorMessage } from "@/lib/utils/errorUtils";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { saveHcfsConfig } from "@/lib/utils/hcfsConfigUtils";
import { migrationCheckAtom, migrationLockAtom, migrationProgressAtom, RESET_MIGRATION_CHECK_STATE } from "@/lib/global-atoms/migrationAtoms";
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
}

interface PollMigrationStatusResult {
  status: string;
  total: number;
  completed: number;
  current_file: string | null;
  /** Real file count from file_records, set when migration completes. */
  logical_file_count: number | null;
  should_warn: boolean;
  should_abort: boolean;
  is_terminal: boolean;
}

export interface UseMigrationReturn {
  currentStep: MigrationStep | null;
  setCurrentStep: (step: MigrationStep | null) => void;
  fileCount: number;
  successCount: number;
  totalSize: number;
  isResuming: boolean;
  migrationSucceeded: boolean;
  transitionError: string | null;
  isTransitioning: boolean;
  checkMigration: (accountId: string) => Promise<boolean>;
  startMigration: (accountId: string, syncPath?: string) => Promise<void>;
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
  const [migrationSucceeded, setMigrationSucceeded] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);

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
          appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0 });
          // Don't show the success dialog -- dismiss the banner and let
          // MigrationChecker re-detect the in-progress job on next check.
          setCurrentStep(null);
          return;
        }
        if (result.status === "poll_error") return;

        // Use logical file count when available for user-facing numbers.
        // The S3 object count (result.total) is used internally for
        // processing progress, but users should see real file counts.
        const displayTotal = result.logical_file_count ?? result.total;
        const displayCompleted = Math.min(result.completed, displayTotal);

        setSuccessCount(displayCompleted);

        appStore.set(migrationProgressAtom, {
          active: true,
          completed: displayCompleted,
          total: displayTotal,
        });

        if (result.is_terminal) {
          stopPolling();
          setMigrationSucceeded(result.status !== "cancelled");
          // Use the real file count (from file_records) when available,
          // falling back to the S3 object count for older servers.
          const realCount = result.logical_file_count ?? result.total;
          setFileCount(realCount);
          setSuccessCount(Math.min(result.completed, realCount));
          setCurrentStep("complete");
          appStore.set(migrationLockAtom, false);
          appStore.set(migrationProgressAtom, {
            active: false,
            completed: Math.min(result.completed, realCount),
            total: realCount,
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
          setMigrationSucceeded(result.completion_status !== "cancelled");
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
      setMigrationSucceeded(false);

      appStore.set(migrationLockAtom, true);

      // Rust now derives the HCFS drive label from the user-chosen sync
      // path — see `derive_migration_label` in `src-tauri/src/sync/migration.rs`.
      // We just thread the path through; the previous TS-side `split("/")`
      // was duplicated in `closeMigration` and could drift.
      const syncPath = appStore.get(migrationCheckAtom).syncPath;

      try {
        await invoke("start_server_migration", { accountId, totalSize, syncPath });

        // Dismiss any open dialogs and activate the banner
        setCurrentStep(null);
        appStore.set(migrationProgressAtom, {
          active: true,
          completed: 0,
          total: fileCount,
        });

        startPolling(accountId);
      } catch (err) {
        console.error("[Migration] Start failed:", err);
        appStore.set(migrationLockAtom, false);
        // Dispatch on the structured `subkind` from Rust
        // (`{kind: "NotReady", subkind: "NOT_ENOUGH_DISK_SPACE", ...}`).
        // Matching substrings of `message` was fragile — any rewording
        // of the Display text in `NotReadyKind` would silently swap
        // users to the generic "try again" toast.
        const typed = err as { kind?: string; subkind?: string } | null;
        if (typed?.kind === "NotReady") {
          switch (typed.subkind) {
            case "NOT_ENOUGH_DISK_SPACE":
              toast.error("Not enough disk space for migration. Please free up space and try again.");
              break;
            case "MASTER_MNEMONIC_UNRECOVERABLE":
              if (authType === "oauth") {
                toast.error(
                  "Migration setup incomplete. Please complete sync setup before starting migration, or contact support if the problem persists."
                );
              } else {
                toast.error(
                  "Seed phrase not available. Please log out and log back in with your seed phrase to start migration."
                );
              }
              break;
            default:
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
    async (accountId: string, syncPath?: string) => {
      // Persist the chosen destination path so closeMigration can pass it to Rust.
      appStore.set(migrationCheckAtom, (prev) => ({ ...prev, syncPath: syncPath ?? null }));

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
    appStore.set(migrationCheckAtom, RESET_MIGRATION_CHECK_STATE);
    appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0 });
    setCurrentStep(null);
  }, []);

  const closeMigration = useCallback(async () => {
    const accountId = activeAccountIdRef.current;
    stopPolling();
    setTransitionError(null);
    setIsTransitioning(true);

    if (accountId) {
      try {
        // Rust derives the drive label from the path server-side via
        // `derive_migration_label` — keeping the rule colocated with
        // the IPC that consumes it means the FE can't accidentally ship
        // one label to `start_server_migration` and another to
        // `complete_migration_transition`.
        const syncPath = appStore.get(migrationCheckAtom).syncPath;
        await invoke("complete_migration_transition", {
          accountId,
          customSyncPath: syncPath,
        });
        // Per-drive Active status is emitted by Rust automatically
        // when complete_migration_transition kicks off the sync init —
        // useDriveStatuses picks it up via the DRIVE_STATUS_CHANGED
        // event, which feeds hasConfiguredDrivesAtom. No FE-side write
        // needed.
      } catch (err) {
        console.error("[Migration] complete_migration_transition failed:", err);
        const errorMsg = errorMessage(err);
        setTransitionError(errorMsg);
        setIsTransitioning(false);
        toast.error("Failed to set up file sync after migration. You can set it up later from Settings.");
        return;
      }
    }

    appStore.set(migrationLockAtom, false);
    appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0 });
    appStore.set(migrationCheckAtom, RESET_MIGRATION_CHECK_STATE);
    setCurrentStep(null);
    setSuccessCount(0);
    setTotalSize(0);
    setFileCount(0);
    setIsResuming(false);
    setMigrationSucceeded(false);
    setTransitionError(null);
    setPendingAccountId(null);
    setIsSettingUp(false);
    setIsTransitioning(false);
    activeAccountIdRef.current = null;
  }, [stopPolling]);

  const dismissAfterError = useCallback(() => {
    appStore.set(migrationLockAtom, false);
    appStore.set(migrationProgressAtom, { active: false, completed: 0, total: 0 });
    appStore.set(migrationCheckAtom, RESET_MIGRATION_CHECK_STATE);
    setCurrentStep(null);
    setTransitionError(null);
  }, []);

  return {
    currentStep,
    setCurrentStep,
    fileCount,
    successCount,
    totalSize,
    isResuming,
    migrationSucceeded,
    transitionError,
    isTransitioning,
    checkMigration,
    startMigration,
    onSetupComplete,
    isSettingUp,
    confirmSkip,
    closeMigration,
    dismissAfterError,
  };
}
