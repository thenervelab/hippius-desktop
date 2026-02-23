"use client";

import React, { useCallback, useEffect } from "react";
import { Icons } from "@/components/ui";
import MigrationPromptDialog from "./MigrationPromptDialog";
import MigrationConfirmSkipDialog from "./MigrationConfirmSkipDialog";
import MigrationProgressDialog from "./MigrationProgressDialog";
import MigrationCompleteDialog from "./MigrationCompleteDialog";
import { useMigration } from "./useMigration";
import type { MigrationFile } from "./MigrationProgressDialog";

interface MigrationPreviewProps {
  className?: string;
}

export const MigrationPreview: React.FC<MigrationPreviewProps> = ({
  className,
}) => {
  const {
    currentStep,
    setCurrentStep,
    files,
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
    startPreview,
    simulateProgress,
    isPreviewMode,
  } = useMigration();

  // Auto-simulate progress when in progress step (preview mode)
  useEffect(() => {
    if (isPreviewMode && currentStep === "progress" && !isCancelling) {
      const timer = setTimeout(() => {
        simulateProgress();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isPreviewMode, currentStep, isCancelling, currentFileIndex, simulateProgress]);

  const totalSize = files.reduce((acc: number, f: MigrationFile) => acc + f.size, 0);
  const currentFileName = files[currentFileIndex]?.name || "";

  const handleSkip = useCallback(() => {
    setCurrentStep("skip-confirm");
  }, [setCurrentStep]);

  const handleCancelSkip = useCallback(() => {
    setCurrentStep("prompt");
  }, [setCurrentStep]);

  return (
    <>
      {/* Preview Button */}
      <button
        className={`flex items-center justify-center gap-1.5 h-9 px-3 py-2 rounded bg-grey-90 border border-grey-80 text-grey-10 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50 hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white ${className || ""}`}
        onClick={startPreview}
      >
        <Icons.Eye className="size-4" />
        <span>Preview Migration</span>
      </button>

      {/* Migration Prompt Dialog */}
      <MigrationPromptDialog
        open={currentStep === "prompt"}
        onClose={closeMigration}
        onMigrate={startMigration}
        onSkip={handleSkip}
        fileCount={files.length}
        totalSize={totalSize}
      />

      {/* Confirm Skip Dialog */}
      <MigrationConfirmSkipDialog
        open={currentStep === "skip-confirm"}
        onClose={handleCancelSkip}
        onConfirm={confirmSkip}
        fileCount={files.length}
      />

      {/* Progress Dialog */}
      <MigrationProgressDialog
        open={currentStep === "progress"}
        onCancel={cancelMigration}
        files={files}
        currentFileIndex={currentFileIndex}
        overallProgress={overallProgress}
        currentFileName={currentFileName}
        isCancelling={isCancelling}
      />

      {/* Complete Dialog */}
      <MigrationCompleteDialog
        open={currentStep === "complete"}
        onClose={closeMigration}
        successCount={successCount}
        failedCount={failedCount}
        totalCount={files.length}
        failedFiles={failedFiles}
      />
    </>
  );
};

export default MigrationPreview;
