"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { MigrationFile } from "./MigrationProgressDialog";
import { getHcfsConfig, saveHcfsConfig } from "@/lib/utils/hcfsConfigUtils";
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
}

interface PollMigrationStatusResult {
  status: string;
  total: number;
  completed: number;
  failed: number;
  failed_files: string[];
  current_file: string | null;
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
  checkMigration: (accountId: string) => Promise<boolean>;
  startMigration: (accountId: string) => Promise<void>;
  onSetupComplete: (result: { serverUrl: string; password: string }) => Promise<void>;
  isSettingUp: boolean;
  cancelMigration: () => Promise<void>;
  confirmSkip: () => Promise<void>;
  closeMigration: () => Promise<void>;
}

const POLL_INTERVAL_MS = 3000;
const MAX_CONSECUTIVE_POLL_FAILURES = 10;
const WARN_AFTER_POLL_FAILURES = 3;

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
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailuresRef = useRef(0);

  const [successCount, setSuccessCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [failedFiles, setFailedFiles] = useState<
    Array<{ name: string; error: string }>
  >([]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (accountId: string) => {
      stopPolling();

      const poll = async () => {
        try {
          const result = await invoke<PollMigrationStatusResult>(
            "poll_migration_status",
            { accountId }
          );

          pollFailuresRef.current = 0;
          setSuccessCount(result.completed);
          setFailedCount(result.failed);
          setCurrentFileIndex(result.completed);

          if (result.total > 0) {
            setOverallProgress((result.completed / result.total) * 100);
          }

          if (result.current_file) {
            setFiles((prev) => {
              const needsUpdate = prev.some(
                (f) => f.name === result.current_file && f.status !== "migrating"
              );
              if (!needsUpdate) return prev;
              return prev.map((f) =>
                f.name === result.current_file
                  ? { ...f, status: "migrating" as const }
                  : f
              );
            });
          }

          // Server returns cumulative failed_files list, so overwriting is correct
          if (result.failed_files.length > 0) {
            setFailedFiles(
              result.failed_files.map((name) => ({
                name,
                error: "Migration failed on server",
              }))
            );
          }

          if (result.status === "completed" || result.status === "failed") {
            stopPolling();
            setOverallProgress(100);
            setCurrentStep("complete");
            appStore.set(migrationLockAtom, false);
          }
        } catch (err) {
          pollFailuresRef.current += 1;
          console.error(
            `[Migration] Poll failed (${pollFailuresRef.current}/${MAX_CONSECUTIVE_POLL_FAILURES}):`,
            err
          );

          if (pollFailuresRef.current === WARN_AFTER_POLL_FAILURES) {
            toast.warning("Having trouble checking migration status. Retrying...");
          }

          if (pollFailuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
            stopPolling();
            toast.error("Lost connection to migration server. Please check your network and try again.");
            appStore.set(migrationLockAtom, false);
            setCurrentStep("complete");
          }
        }
      };

      // Poll immediately, then on interval
      poll();
      pollIntervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
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
        if (result.needs_migration) {
          const migrationFiles: MigrationFile[] = result.files.map((f) => ({
            arionHash: "",
            name: `${f.bucket_name}/${f.key}`,
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
    async (accountId: string) => {
      setCurrentStep("progress");
      setOverallProgress(0);
      setSuccessCount(0);
      setFailedCount(0);
      setFailedFiles([]);
      setCurrentFileIndex(0);

      // Lock the app — block sync operations
      appStore.set(migrationLockAtom, true);

      try {
        // Derive path_prefix from migration files (bucket name)
        const firstFile = files[0];
        const pathPrefix = firstFile
          ? firstFile.name.split("/")[0] || ""
          : "";

        await invoke("start_server_migration", {
          accountId,
          pathPrefix,
          totalSize,
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
    [files, totalSize, startPolling]
  );

  const startMigration = useCallback(
    async (accountId: string) => {
      // Check if HCFS config (encryption password) exists
      try {
        const config = await getHcfsConfig(accountId);
        if (!config.has_password) {
          setPendingAccountId(accountId);
          setCurrentStep("setup");
          return;
        }
      } catch {
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

  const cancelMigration = useCallback(async () => {
    setIsCancelling(true);
    try {
      const accountId = activeAccountIdRef.current;
      if (accountId) {
        await invoke("cancel_server_migration", { accountId });
      }
    } catch (err) {
      console.error("[Migration] Cancel failed:", err);
    }
    stopPolling();
    appStore.set(migrationLockAtom, false);
    setIsCancelling(false);
    setCurrentStep("complete");
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
    try {
      if (accountId) {
        const existingMnemonic = getMnemonic ? await getMnemonic() : null;
        await invoke("complete_migration_transition", {
          accountId,
          existingMnemonic: existingMnemonic ?? null,
        });
        appStore.set(syncEngineStatusAtom, "active");
        appStore.set(isSyncConfiguredAtom, true);
      }
    } catch (err) {
      console.error("[Migration] close failed:", err);
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
    setPendingAccountId(null);
    setIsSettingUp(false);
    activeAccountIdRef.current = null;
  }, [getMnemonic, stopPolling]);

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
    checkMigration,
    startMigration,
    onSetupComplete,
    isSettingUp,
    cancelMigration,
    confirmSkip,
    closeMigration,
  };
}
