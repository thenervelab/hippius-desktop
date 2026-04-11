import { atom } from "jotai";

export interface MigrationCheckState {
  checked: boolean;
  needsMigration: boolean;
  fileCount: number;
  totalSize: number;
  /** When true, MigrationChecker should call check_migration. */
  shouldCheck: boolean;
  /** User-chosen destination folder for migrated files. Null means use the default. */
  syncPath: string | null;
}

export const DEFAULT_MIGRATION_CHECK_STATE: MigrationCheckState = {
  checked: false,
  needsMigration: false,
  fileCount: 0,
  totalSize: 0,
  shouldCheck: false,
  syncPath: null,
};

/** Reset state used after migration completes, is skipped, or errors out. */
export const RESET_MIGRATION_CHECK_STATE: MigrationCheckState = {
  ...DEFAULT_MIGRATION_CHECK_STATE,
  checked: true,
};

export const migrationCheckAtom = atom<MigrationCheckState>(DEFAULT_MIGRATION_CHECK_STATE);


/** When true, sync cycles and drive operations are blocked (server-side migration in progress). */
export const migrationLockAtom = atom(false);

export interface MigrationProgress {
  active: boolean;
  completed: number;
  total: number;
}

/** Tracks live migration progress for the banner. */
export const migrationProgressAtom = atom<MigrationProgress>({
  active: false,
  completed: 0,
  total: 0,
});
