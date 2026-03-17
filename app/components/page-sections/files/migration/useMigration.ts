"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { MigrationFile } from "./MigrationProgressDialog";
import { getHcfsConfig, saveHcfsConfig } from "@/lib/utils/hcfsConfigUtils";
import { syncEngineStatusAtom, isSyncConfiguredAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { migrationCheckAtom } from "@/lib/global-atoms/migrationAtoms";
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
  phase: "downloading" | "syncing";
  uploadedCount: number;
  currentUploadFile: string;
  checkMigration: (accountId: string) => Promise<boolean>;
  startMigration: (accountId: string) => Promise<void>;
  onSetupComplete: (result: { serverUrl: string; password: string }) => Promise<void>;
  isSettingUp: boolean;
  cancelMigration: () => Promise<void>;
  confirmSkip: () => Promise<void>;
  closeMigration: () => Promise<void>;
}

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
  const [resumeSyncPath, setResumeSyncPath] = useState<string | null>(null);

  const [phase, setPhase] = useState<"downloading" | "syncing">("downloading");
  const [uploadedCount, setUploadedCount] = useState(0);
  const [currentUploadFile, setCurrentUploadFile] = useState("");
  const uploadedFilesRef = useRef(new Set<string>());
  const totalFilesRef = useRef(0);

  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null);
  const [isSettingUp, setIsSettingUp] = useState(false);

  // Tracks the account ID across the entire migration lifecycle so
  // confirmSkip / cancelMigration / closeMigration can persist the choice.
  const activeAccountIdRef = useRef<string | null>(null);

  const [successCount, setSuccessCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [failedFiles, setFailedFiles] = useState<
    Array<{ name: string; error: string }>
  >([]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    listen<MigrationProgressPayload>("migration_progress", (event) => {
      const { phase: eventPhase, current_file, completed, total, failed } = event.payload;
      setPhase(eventPhase);
      totalFilesRef.current = total;
      if (eventPhase === "downloading") {
        setOverallProgress(total > 0 ? (completed / total) * 50 : 0);
      }
      setSuccessCount(Number(completed));
      setFailedCount(Number(failed));
      setCurrentFileIndex(Number(completed));

      setFiles((prev) => {
        let completedSoFar = 0;
        return prev.map((f) => {
          if (f.status === "failed") return f;
          if (completedSoFar < completed && f.name !== current_file) {
            completedSoFar++;
            return f.status === "completed"
              ? f
              : { ...f, status: "completed" as const };
          }
          if (f.name === current_file) {
            return { ...f, status: "migrating" as const };
          }
          return f;
        });
      });
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
      setOverallProgress(100);
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

    listen<{ label: string; bytes: number; total: number; path: string | null }>(
      "hcfs_upload_progress",
      (event) => {
        const { label, bytes, total, path } = event.payload;
        if (label !== "migration") return;

        if (path) {
          const fileName = path.split("/").pop() || path;
          setCurrentUploadFile(fileName);
        }

        if (bytes === total && total > 0 && path) {
          if (!uploadedFilesRef.current.has(path)) {
            uploadedFilesRef.current.add(path);
            const count = uploadedFilesRef.current.size;
            setUploadedCount(count);
            const totalFiles = totalFilesRef.current;
            if (totalFiles > 0) {
              setOverallProgress(50 + (count / totalFiles) * 50);
            }
          }
        }
      }
    ).then((u) => unlisteners.push(u));

    return () => {
      unlisteners.forEach((u) => u());
    };
  }, []);

  const checkMigration = useCallback(
    async (accountId: string): Promise<boolean> => {
      // Reset shouldCheck so the effect doesn't re-fire on account switch
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
          setResumeSyncPath(result.sync_path);
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

  const launchMigration = useCallback(
    async (accountId: string, syncPath: string) => {
      setCurrentStep("progress");
      setOverallProgress(0);
      setSuccessCount(0);
      setFailedCount(0);
      setFailedFiles([]);
      setCurrentFileIndex(0);
      setPhase("downloading");
      setUploadedCount(0);
      setCurrentUploadFile("");
      uploadedFilesRef.current.clear();

      try {
        const mnemonic = getMnemonic ? await getMnemonic() : null;
        await invoke("start_migration", {
          accountId,
          syncPath,
          mnemonic: mnemonic ?? null,
        });
        // Migration drive started syncing — mark engine as active
        appStore.set(isSyncConfiguredAtom, true);
        appStore.set(syncEngineStatusAtom, "active");
      } catch (err) {
        console.error("[Migration] Start failed:", err);
      }
    },
    [getMnemonic]
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

      await launchMigration(accountId, syncPath);
    },
    [resumeSyncPath, launchMigration]
  );

  const onSetupComplete = useCallback(
    async (result: { serverUrl: string; password: string }) => {
      if (!pendingAccountId) return;
      setIsSettingUp(true);

      try {
        await saveHcfsConfig(pendingAccountId, result.serverUrl, result.password);

        let syncPath = resumeSyncPath;

        if (!syncPath) {
          const selected = await open({
            directory: true,
            multiple: false,
            title: "Choose Migration Folder",
          });
          if (!selected) {
            setCurrentStep("prompt");
            setIsSettingUp(false);
            return;
          }
          syncPath = selected as string;
        }

        setIsSettingUp(false);
        await launchMigration(pendingAccountId, syncPath);
      } catch (err) {
        console.error("[Migration] Setup failed:", err);
        setIsSettingUp(false);
        setCurrentStep("prompt");
      }
    },
    [pendingAccountId, resumeSyncPath, launchMigration]
  );

  const cancelMigration = useCallback(async () => {
    setIsCancelling(true);
    try {
      const accountId = activeAccountIdRef.current;
      if (accountId) {
        await invoke("cancel_migration", { accountId });
      } else {
        // Fallback: at minimum stop the download loop
        await invoke("cancel_migration", { accountId: "" });
      }
    } catch (err) {
      console.error("[Migration] Cancel failed:", err);
    }
    setIsCancelling(false);
    setCurrentStep("complete");
  }, []);

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
    // Reset the atom so the checker doesn't re-trigger
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
    try {
      if (accountId) {
        const mnemonic = getMnemonic ? await getMnemonic() : null;
        await invoke("complete_migration_transition", {
          accountId,
          existingMnemonic: mnemonic,
        });
        appStore.set(syncEngineStatusAtom, "active");
        appStore.set(isSyncConfiguredAtom, true);
      }
    } catch (err) {
      console.error("[Migration] complete_migration_transition failed:", err);
    }
    // Reset the atom so the checker doesn't re-trigger
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
    setResumeSyncPath(null);
    setPendingAccountId(null);
    setIsSettingUp(false);
    setPhase("downloading");
    setUploadedCount(0);
    setCurrentUploadFile("");
    uploadedFilesRef.current.clear();
    activeAccountIdRef.current = null;
  }, [getMnemonic]);

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
    phase,
    uploadedCount,
    currentUploadFile,
    checkMigration,
    startMigration,
    onSetupComplete,
    isSettingUp,
    cancelMigration,
    confirmSkip,
    closeMigration,
  };
}
