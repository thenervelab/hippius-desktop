"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { MigrationFile } from "./MigrationProgressDialog";
import { saveHcfsConfig } from "@/lib/utils/hcfsConfigUtils";
import { syncEngineStatusAtom, isSyncConfiguredAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { migrationCheckAtom, migrationLockAtom } from "@/lib/global-atoms/migrationAtoms";
import { appStore } from "@/lib/store/jotaiStore";

export type MigrationStep = "prompt" | "skip-confirm" | "setup" | "progress" | "complete";

interface MigrationCheckResult {
  needs_migration: boolean;
  file_count: number;
  total_size: number;
  files: Array<{
    user_id: string;
    bucket_name: string;
    key: string;
    size_bytes: number;
    is_public: boolean;
    status: string;
  }>;
  sync_path: string | null;
  is_resuming: boolean;
  /** Server migration finished but client never ran complete_migration_transition */
  needs_completion: boolean;
  /** When needs_completion is true, the server job's final status */
  completion_status: string | null;
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
}

export interface UseMigrationReturn {
  currentStep: MigrationStep | null;
  setCurrentStep: (step: MigrationStep | null) => void;
  files: MigrationFile[];
  currentFileIndex: number;
  overallProgress: number;
  isCancelling: boolean;
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
  cancelMigration: () => Promise<void>;
  confirmSkip: () => Promise<void>;
  closeMigration: () => Promise<void>;
  dismissAfterError: () => void;
}

/** Server statuses that mean the migration job is done (no more polling). */
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

export function useMigration(
  getMnemonic?: () => Promise<string | null>
): UseMigrationReturn {
  const [currentStep, setCurrentStep] = useState<MigrationStep | null>(null);
  const [files, setFiles] = useState<MigrationFile[]>([]);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [overallProgress, setOverallProgress] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);
  const [totalSize, setTotalSize] = useState(0);
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
  // Track whether the migration actually succeeded (vs failed/cancelled)
  const [migrationSucceeded, setMigrationSucceeded] = useState(false);
  // Error from complete_migration_transition — shown in the complete dialog
  const [transitionError, setTransitionError] = useState<string | null>(null);

  // Clean up event listener on unmount
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

      // Listen for migration_progress events from Rust background task
      const unlisten = await listen<PollMigrationStatusResult>("migration_progress", (event) => {
        const result = event.payload;

        // Handle poll failure flags from Rust
        if (result.should_warn) {
          toast.warning("Having trouble checking migration status. Retrying...");
        }
        if (result.should_abort) {
          stopPolling();
          toast.error("Lost connection to migration server. Please check your network and try again.");
          appStore.set(migrationLockAtom, false);
          setMigrationSucceeded(false);
          setCurrentStep("complete");
          return;
        }
        if (result.status === "poll_error") return; // Transient failure, Rust is counting

        setSuccessCount(result.completed);
        setFailedCount(result.failed);
        setCurrentFileIndex(result.completed);

        if (result.total > 0) {
          setOverallProgress((result.completed / result.total) * 100);
        }

        // Update per-file statuses using serverKey for matching
        setFiles((prev) =>
          prev.map((f, index) => {
            const key = f.serverKey ?? f.name;
            if (result.failed_files.includes(key))
              return f.status === "failed" ? f : { ...f, status: "failed" as const };
            if (index < result.completed)
              return f.status === "completed" ? f : { ...f, status: "completed" as const };
            if (result.current_file && key === result.current_file)
              return f.status === "migrating" ? f : { ...f, status: "migrating" as const };
            return f;
          })
        );

        if (result.failed_files.length > 0) {
          setFailedFiles(
            result.failed_files.map((name) => ({
              name,
              error: "Migration failed on server",
            }))
          );
        }

        if (TERMINAL_STATUSES.includes(result.status)) {
          stopPolling();
          setOverallProgress(100);
          setMigrationSucceeded(result.status === "completed");
          setCurrentStep("complete");
          appStore.set(migrationLockAtom, false);
        }
      });
      unlistenRef.current = unlisten;

      // Start Rust background polling task
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
        // Server migration finished but client transition never ran
        // (e.g. app restarted mid-migration) — show completion dialog.
        if (result.needs_completion) {
          setMigrationSucceeded(result.completion_status === "completed");
          activeAccountIdRef.current = accountId;
          setCurrentStep("complete");
          return true;
        }

        if (result.needs_migration) {
          const migrationFiles: MigrationFile[] = result.files.map((f) => ({
            arionHash: "",
            name: `${f.bucket_name}/${f.key}`,
            serverKey: f.key,
            size: f.size_bytes,
            status: "pending" as const,
          }));
          setFiles(migrationFiles);
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
    []
  );

  const launchServerMigration = useCallback(
    async (accountId: string, mnemonic: string) => {
      setCurrentStep("progress");
      setOverallProgress(0);
      setSuccessCount(0);
      setFailedCount(0);
      setFailedFiles([]);
      setCurrentFileIndex(0);
      setMigrationSucceeded(false);

      // Lock the app — block sync operations
      appStore.set(migrationLockAtom, true);

      try {
        await invoke("start_server_migration", {
          accountId,
          totalSize,
          existingMnemonic: mnemonic,
        });

        // Start polling for progress
        startPolling(accountId);
      } catch (err) {
        console.error("[Migration] Start failed:", err);
        appStore.set(migrationLockAtom, false);
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (errorMsg.includes("Not enough disk space")) {
          toast.error("Not enough disk space for migration. Please free up space and try again.");
        } else {
          toast.error("Failed to start migration. Please try again.");
        }
        setCurrentStep("prompt");
      }
    },
    [totalSize, startPolling]
  );

  const startMigration = useCallback(
    async (accountId: string) => {
      // Resolve mnemonic once — it's needed for encryption key derivation.
      const mnemonic = getMnemonic ? await getMnemonic() : null;
      if (!mnemonic) {
        toast.error(
          "Seed phrase not available. Please log out and log back in with your seed phrase to start migration."
        );
        return;
      }

      // Rust checks HCFS config and returns which step to show
      const flow = await invoke<{ nextStep: string }>("start_migration_flow", { accountId });
      if (flow.nextStep === "setup") {
        setPendingAccountId(accountId);
        setCurrentStep("setup");
        return;
      }
      // Password exists but mnemonic file may not — persist it before launching
      await invoke("persist_master_mnemonic", {
        accountId,
        mnemonic,
      }).catch((err: unknown) =>
        console.warn("[Migration] persist_master_mnemonic failed:", err)
      );
      await launchServerMigration(accountId, mnemonic);
    },
    [launchServerMigration, getMnemonic]
  );

  const onSetupComplete = useCallback(
    async (result: { serverUrl: string; password: string }) => {
      if (!pendingAccountId) return;
      setIsSettingUp(true);

      try {
        await saveHcfsConfig(pendingAccountId, result.serverUrl, result.password);

        // Resolve mnemonic once and thread it through the entire flow.
        const mnemonic = getMnemonic ? await getMnemonic() : null;
        if (!mnemonic) {
          setIsSettingUp(false);
          toast.error(
            "Seed phrase not available. Please log out and log back in with your seed phrase to start migration."
          );
          setCurrentStep("prompt");
          return;
        }

        // Persist the master mnemonic to disk now that the drive password
        // exists — needed for future sessions.
        await invoke("persist_master_mnemonic", {
          accountId: pendingAccountId,
          mnemonic,
        }).catch((err: unknown) =>
          console.warn("[Migration] persist_master_mnemonic failed:", err)
        );

        setIsSettingUp(false);
        await launchServerMigration(pendingAccountId, mnemonic);
      } catch (err) {
        console.error("[Migration] Setup failed:", err);
        setIsSettingUp(false);
        setCurrentStep("prompt");
      }
    },
    [pendingAccountId, launchServerMigration, getMnemonic]
  );

  const cancelMigration = useCallback(async () => {
    setIsCancelling(true);
    try {
      const accountId = activeAccountIdRef.current;
      if (accountId) {
        await invoke("cancel_server_migration", { accountId });
      }
    } catch (err) {
      console.error("[Migration] Cancel failed:", err);
      toast.error("Failed to cancel migration. The server may still be processing.");
    }
    stopPolling();
    appStore.set(migrationLockAtom, false);
    setIsCancelling(false);
    setMigrationSucceeded(false);
    setCurrentStep(null);
  }, [stopPolling]);

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
    setCurrentStep(null);
  }, []);

  const closeMigration = useCallback(async () => {
    const accountId = activeAccountIdRef.current;
    stopPolling();
    setTransitionError(null);
    // Close the dialog immediately so the user isn't blocked
    setCurrentStep(null);

    // Complete the migration transition for any terminal state — even partial
    // failures have successfully migrated files that should be accessible via sync.
    if (accountId) {
      try {
        const existingMnemonic = getMnemonic ? await getMnemonic() : null;
        await invoke("complete_migration_transition", {
          accountId,
          existingMnemonic: existingMnemonic ?? null,
        });
        appStore.set(syncEngineStatusAtom, "active");
        appStore.set(isSyncConfiguredAtom, true);
      } catch (err) {
        console.error("[Migration] complete_migration_transition failed:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        setTransitionError(errorMsg);
        // Re-open the dialog so the user can retry
        setCurrentStep("complete");
        toast.error("Failed to set up file sync after migration. You can retry or close and set it up later.");
        return; // Keep dialog open so user can retry
      }
    }

    appStore.set(migrationLockAtom, false);
    appStore.set(migrationCheckAtom, {
      checked: true,
      needsMigration: false,
      fileCount: 0,
      totalSize: 0,
      shouldCheck: false,
    });
    setCurrentStep(null);
    setFiles([]);
    setCurrentFileIndex(0);
    setOverallProgress(0);
    setSuccessCount(0);
    setFailedCount(0);
    setFailedFiles([]);
    setTotalSize(0);
    setIsResuming(false);
    setMigrationSucceeded(false);
    setTransitionError(null);
    setPendingAccountId(null);
    setIsSettingUp(false);
    activeAccountIdRef.current = null;
  }, [getMnemonic, stopPolling]);

  /** Dismiss the dialog after a transition error — user can set up sync manually. */
  const dismissAfterError = useCallback(() => {
    appStore.set(migrationLockAtom, false);
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
    files,
    currentFileIndex,
    overallProgress,
    isCancelling,
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
    cancelMigration,
    confirmSkip,
    closeMigration,
    dismissAfterError,
  };
}
