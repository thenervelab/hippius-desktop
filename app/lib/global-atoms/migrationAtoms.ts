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

/** When true, sync cycles and drive operations are blocked (server-side migration in progress). */
export const migrationLockAtom = atom(false);

export interface MigrationProgress {
  active: boolean;
  completed: number;
  total: number;
  failed: number;
}

/** Tracks live migration progress for the banner. */
export const migrationProgressAtom = atom<MigrationProgress>({
  active: false,
  completed: 0,
  total: 0,
  failed: 0,
});
