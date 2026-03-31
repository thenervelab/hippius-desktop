import { atom } from "jotai";

export interface MigrationCheckState {
  checked: boolean;
  needsMigration: boolean;
  fileCount: number;
  totalSize: number;
  /** When true, MigrationChecker should call check_migration. */
  shouldCheck: boolean;
}

export const migrationCheckAtom = atom<MigrationCheckState>({
  checked: false,
  needsMigration: false,
  fileCount: 0,
  totalSize: 0,
  shouldCheck: false,
});

export const showMigrationPromptAtom = atom(false);
