"use client";

import { useState, useCallback } from "react";
import { MigrationFile } from "./MigrationProgressDialog";

export type MigrationStep = "prompt" | "skip-confirm" | "progress" | "complete";

export interface UseMigrationReturn {
  // Dialog visibility
  currentStep: MigrationStep | null;
  setCurrentStep: (step: MigrationStep | null) => void;
  
  // Migration data
  files: MigrationFile[];
  setFiles: (files: MigrationFile[]) => void;
  currentFileIndex: number;
  overallProgress: number;
  isCancelling: boolean;
  
  // Results
  successCount: number;
  failedCount: number;
  failedFiles: Array<{ name: string; error: string }>;
  
  // Actions
  startMigration: () => void;
  cancelMigration: () => void;
  confirmSkip: () => void;
  closeMigration: () => void;
  
  // Preview mode (for testing UI)
  isPreviewMode: boolean;
  startPreview: () => void;
  simulateProgress: () => void;
}

// Mock files for preview mode
const mockFiles: MigrationFile[] = [
  { arionHash: "Qm1234567890abcdef", name: "document.pdf", size: 2456789, status: "pending" },
  { arionHash: "Qm2345678901bcdefg", name: "vacation-photo.jpg", size: 4567890, status: "pending" },
  { arionHash: "Qm3456789012cdefgh", name: "presentation.pptx", size: 8901234, status: "pending" },
  { arionHash: "Qm4567890123defghi", name: "spreadsheet.xlsx", size: 1234567, status: "pending" },
  { arionHash: "Qm5678901234efghij", name: "notes.txt", size: 12345, status: "pending" },
];

export function useMigration(): UseMigrationReturn {
  const [currentStep, setCurrentStep] = useState<MigrationStep | null>(null);
  const [files, setFiles] = useState<MigrationFile[]>([]);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [overallProgress, setOverallProgress] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  
  // Results
  const [successCount, setSuccessCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [failedFiles, setFailedFiles] = useState<Array<{ name: string; error: string }>>([]);

  const startPreview = useCallback(() => {
    setIsPreviewMode(true);
    setFiles(mockFiles.map(f => ({ ...f, status: "pending" })));
    setCurrentFileIndex(0);
    setOverallProgress(0);
    setSuccessCount(0);
    setFailedCount(0);
    setFailedFiles([]);
    setIsCancelling(false);
    setCurrentStep("prompt");
  }, []);

  const startMigration = useCallback(() => {
    setCurrentStep("progress");
    // In preview mode, we just show the dialog
    // Real implementation would call backend
  }, []);

  const simulateProgress = useCallback(() => {
    // Simulate migration progress for preview
    const updatedFiles = [...files];
    let completed = 0;
    let failed = 0;
    const failures: Array<{ name: string; error: string }> = [];

    updatedFiles.forEach((file, index) => {
      if (index < currentFileIndex) {
        // Already processed - keep status
      } else if (index === currentFileIndex) {
        // Current file - mark as migrating
        file.status = "migrating";
      }
    });

    setFiles(updatedFiles);

    // Simulate completing current file after a delay
    setTimeout(() => {
      const newFiles = [...updatedFiles];
      const currentFile = newFiles[currentFileIndex];
      
      // Simulate 80% success, 20% failure
      if (Math.random() > 0.2) {
        currentFile.status = "completed";
        completed = files.filter((f, i) => i < currentFileIndex && f.status === "completed").length + 1;
      } else {
        currentFile.status = "failed";
        currentFile.error = "Network timeout";
        failed = files.filter((f, i) => i < currentFileIndex && f.status === "failed").length + 1;
        failures.push({ name: currentFile.name, error: "Network timeout" });
      }

      setFiles(newFiles);
      setSuccessCount(completed);
      setFailedCount(failed);
      setFailedFiles(failures);
      
      const newProgress = ((currentFileIndex + 1) / files.length) * 100;
      setOverallProgress(newProgress);

      if (currentFileIndex < files.length - 1) {
        setCurrentFileIndex(currentFileIndex + 1);
      } else {
        // Migration complete
        const finalSuccess = newFiles.filter(f => f.status === "completed").length;
        const finalFailed = newFiles.filter(f => f.status === "failed").length;
        const finalFailures = newFiles
          .filter(f => f.status === "failed")
          .map(f => ({ name: f.name, error: f.error || "Unknown error" }));
        
        setSuccessCount(finalSuccess);
        setFailedCount(finalFailed);
        setFailedFiles(finalFailures);
        setCurrentStep("complete");
      }
    }, 1000);
  }, [files, currentFileIndex]);

  const cancelMigration = useCallback(() => {
    setIsCancelling(true);
    // Simulate cancellation
    setTimeout(() => {
      const completedFiles = files.filter(f => f.status === "completed").length;
      const failedFiles = files.filter(f => f.status === "failed");
      
      setSuccessCount(completedFiles);
      setFailedCount(failedFiles.length);
      setFailedFiles(failedFiles.map(f => ({ name: f.name, error: f.error || "Cancelled" })));
      setIsCancelling(false);
      setCurrentStep("complete");
    }, 1500);
  }, [files]);

  const confirmSkip = useCallback(() => {
    // In real implementation, this would call backend to mark migration as skipped
    setCurrentStep(null);
    setIsPreviewMode(false);
  }, []);

  const closeMigration = useCallback(() => {
    setCurrentStep(null);
    setIsPreviewMode(false);
    setFiles([]);
    setCurrentFileIndex(0);
    setOverallProgress(0);
    setSuccessCount(0);
    setFailedCount(0);
    setFailedFiles([]);
  }, []);

  return {
    currentStep,
    setCurrentStep,
    files,
    setFiles,
    currentFileIndex,
    overallProgress,
    isCancelling,
    successCount,
    failedCount,
    failedFiles,
    startMigration,
    cancelMigration,
    confirmSkip,
    closeMigration,
    isPreviewMode,
    startPreview,
    simulateProgress,
  };
}
