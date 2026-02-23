import { atom } from "jotai";

export interface MigrationFileItem {
  name: string;
  size: number;
  status: "pending" | "downloading" | "uploading" | "complete" | "error";
  error?: string;
}

export interface MigrationState {
  needsMigration: boolean;
  isChecking: boolean;
  isInProgress: boolean;
  currentStep: "idle" | "downloading" | "uploading" | "complete" | "cancelled" | "skipped";
  progress: number;
  currentFile: string;
  completedFiles: number;
  totalFiles: number;
  totalSize: number;
  successCount: number;
  failedCount: number;
  failedFiles: string[];
  fileList: MigrationFileItem[];
}

const initialMigrationState: MigrationState = {
  needsMigration: false,
  isChecking: false,
  isInProgress: false,
  currentStep: "idle",
  progress: 0,
  currentFile: "",
  completedFiles: 0,
  totalFiles: 0,
  totalSize: 0,
  successCount: 0,
  failedCount: 0,
  failedFiles: [],
  fileList: [],
};

export const migrationStateAtom = atom<MigrationState>(initialMigrationState);

// Dialog visibility atoms
export const showMigrationPromptAtom = atom(false);
export const showMigrationProgressAtom = atom(false);
export const showMigrationCompleteAtom = atom(false);
export const showMigrationSkipConfirmAtom = atom(false);

// For preview/demo purposes - toggle this to simulate migration needed
export const previewMigrationAtom = atom(false);
