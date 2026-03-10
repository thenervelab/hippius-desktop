"use client";

import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { MigrationFile } from "./MigrationProgressDialog";

export type MigrationStep = "prompt" | "skip-confirm" | "progress" | "complete";

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

interface MigrationProgressPayload {
  phase: "downloading" | "syncing";
  current_file: string;
  completed: number;
  total: number;
  failed: number;
}

interface MigrationFileErrorPayload {
  file_name: string;
  bucket: string;
  error: string;
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
  cancelMigration: () => Promise<void>;
  confirmSkip: () => void;
  closeMigration: () => void;
}

export function useMigration(): UseMigrationReturn {
  const [currentStep, setCurrentStep] = useState<MigrationStep | null>(null);
  const [files, setFiles] = useState<MigrationFile[]>([]);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [overallProgress, setOverallProgress] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);
  const [totalSize, setTotalSize] = useState(0);
  const [isResuming, setIsResuming] = useState(false);
  const [resumeSyncPath, setResumeSyncPath] = useState<string | null>(null);

  const [successCount, setSuccessCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [failedFiles, setFailedFiles] = useState<
    Array<{ name: string; error: string }>
  >([]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    listen<MigrationProgressPayload>("migration_progress", (event) => {
      const { current_file, completed, total, failed } = event.payload;
      setOverallProgress(total > 0 ? (completed / total) * 100 : 0);
      setSuccessCount(Number(completed));
      setFailedCount(Number(failed));
      setCurrentFileIndex(Number(completed));

      setFiles((prev) =>
        prev.map((f) => {
          if (f.name === current_file && f.status === "pending") {
            return { ...f, status: "migrating" as const };
          }
          return f;
        })
      );
    }).then((u) => unlisteners.push(u));

    listen<MigrationFileErrorPayload>("migration_file_error", (event) => {
      const { file_name, error } = event.payload;
      setFailedFiles((prev) => [...prev, { name: file_name, error }]);
      setFiles((prev) =>
        prev.map((f) =>
          f.name === file_name
            ? { ...f, status: "failed" as const, error }
            : f
        )
      );
    }).then((u) => unlisteners.push(u));

    listen("migration_complete", () => {
      setCurrentStep("complete");
    }).then((u) => unlisteners.push(u));

    listen<{ error: string }>("migration_error", (event) => {
      console.error("[Migration] Background error:", event.payload.error);
      setFailedFiles((prev) => [
        ...prev,
        { name: "Migration", error: event.payload.error },
      ]);
      setCurrentStep("complete");
    }).then((u) => unlisteners.push(u));

    return () => {
      unlisteners.forEach((u) => u());
    };
  }, []);

  const checkMigration = useCallback(
    async (accountId: string): Promise<boolean> => {
      try {
        const result = await invoke<MigrationCheckResult>(
          "check_migration",
          { accountId }
        );
        if (result.needs_migration) {
          const migrationFiles: MigrationFile[] = result.files.map((f) => ({
            arionHash: "",
            name: f.key,
            size: f.size_bytes,
            status: "pending" as const,
          }));
          setFiles(migrationFiles);
          setTotalSize(result.total_size);
          setIsResuming(result.is_resuming);
          setResumeSyncPath(result.sync_path);
          setCurrentStep("prompt");
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

  const startMigration = useCallback(
    async (accountId: string) => {
      let syncPath = resumeSyncPath;

      if (!syncPath) {
        const selected = await open({
          directory: true,
          multiple: false,
          title: "Choose Migration Folder",
        });
        if (!selected) return;
        syncPath = selected as string;
      }

      setCurrentStep("progress");
      setOverallProgress(0);
      setSuccessCount(0);
      setFailedCount(0);
      setFailedFiles([]);
      setCurrentFileIndex(0);

      try {
        await invoke("start_migration", { accountId, syncPath });
      } catch (err) {
        console.error("[Migration] Start failed:", err);
      }
    },
    [resumeSyncPath]
  );

  const cancelMigration = useCallback(async () => {
    setIsCancelling(true);
    try {
      await invoke("cancel_migration");
    } catch (err) {
      console.error("[Migration] Cancel failed:", err);
    }
    setIsCancelling(false);
    setCurrentStep("complete");
  }, []);

  const confirmSkip = useCallback(() => {
    setCurrentStep(null);
  }, []);

  const closeMigration = useCallback(() => {
    setCurrentStep(null);
    setFiles([]);
    setCurrentFileIndex(0);
    setOverallProgress(0);
    setSuccessCount(0);
    setFailedCount(0);
    setFailedFiles([]);
    setTotalSize(0);
    setIsResuming(false);
    setResumeSyncPath(null);
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
    checkMigration,
    startMigration,
    cancelMigration,
    confirmSkip,
    closeMigration,
  };
}
