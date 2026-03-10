import { atom } from "jotai";

export interface MigrationCheckState {
  checked: boolean;
  needsMigration: boolean;
  fileCount: number;
  totalSize: number;
}

export const migrationCheckAtom = atom<MigrationCheckState>({
  checked: false,
  needsMigration: false,
  fileCount: 0,
  totalSize: 0,
});

export const showMigrationPromptAtom = atom(false);
