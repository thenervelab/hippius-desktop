// Dev-only floating panel for previewing the app's transient dialogs and
// banners (migration flow, sync conflicts, merge/staged changes, failed
// files, credits exhausted) without having to reproduce the backend
// conditions that normally trigger them.
//
// It drives the REAL components two ways so what you see here is exactly
// what ships:
//   * Atom-driven surfaces (the three top-of-page banners + the "Sync
//     Issues" modal) are already mounted in the protected layout. We just
//     write mock data into their atoms and the live component appears.
//   * Prop-driven dialogs (the migration flow + the staged-changes review
//     dialog) are normally mounted on demand by `MigrationChecker`, so we
//     mount local instances here with mock props and no-op handlers.
//
// This is pure presentation tooling — no business logic. It renders only
// in development builds (`NODE_ENV === "development"`, set by `tauri:dev`)
// and is tree-shaken out of production bundles, so there is no flag to
// flip and nothing ships to users.

"use client";

import { useState } from "react";
import { useSetAtom } from "jotai";
import { Wrench, X } from "lucide-react";

import { migrationProgressAtom } from "@/lib/global-atoms/migrationAtoms";
import {
  pendingConflictsAtom,
  creditsExhaustedAtom,
  failedFilesAtom,
  type FailedFileInfo,
  type CreditsExhaustedInfo,
} from "@/lib/store/syncAtoms";
import type { StagedChanges } from "@/lib/types/syncTypes";
import {
  MigrationPromptDialog,
  MigrationConfirmSkipDialog,
  MigrationCompleteDialog,
} from "@/components/page-sections/drive/migration";
import StagedChangesDialog from "@/components/page-sections/drive/StagedChangesDialog";
import { cn } from "@/lib/utils";

// --- Mock fixtures ----------------------------------------------------------
// Hand-picked so each surface renders representative content: mixed
// operation types for the staged-changes dialog, both a modify/modify and a
// modify/delete conflict, a couple of failed files (so the modal's bulk-
// action bar shows), etc.

const MOCK_STAGED_CHANGES: StagedChanges = {
  uploads: [
    { file_id: "u1", path: "Documents/Q3-report.pdf" },
    { file_id: "u2", path: "Photos/vacation-2024.jpg" },
  ],
  downloads: [{ file_id: "d1", path: "Notes/todo.md" }],
  local_deletes: [{ file_id: "ld1", path: "Archive/old-backup.zip" }],
  remote_deletes: [{ file_id: "rd1", path: "Drafts/scratch.txt" }],
  conflicts: [
    {
      file_id: "c1",
      path: "Documents/budget.xlsx",
      conflict_type: "modify_modify",
      has_local: true,
      has_remote: true,
    },
    {
      file_id: "c2",
      path: "Notes/ideas.txt",
      conflict_type: "modify_delete",
      has_local: true,
      has_remote: false,
    },
  ],
  unchanged_count: 42,
};

const MOCK_FAILED_FILES: FailedFileInfo[] = [
  {
    label: "Documents",
    path: "reports/q3.pdf",
    fileName: "q3.pdf",
    error: "Upload timed out after 3 attempts",
    failureCount: 5,
  },
  {
    label: "Photos",
    path: "raw/IMG_4821.cr2",
    fileName: "IMG_4821.cr2",
    error: "Encryption failed",
    failureCount: 4,
  },
];

const MOCK_CREDITS_EXHAUSTED: CreditsExhaustedInfo = {
  label: "Documents",
  balanceCents: 12,
  requiredCents: 150,
  fileCount: 3,
};

const MOCK_MIGRATION_PROGRESS = { active: true, completed: 128, total: 512 };

const MOCK_MIGRATION_FILE_COUNT = 247;
const MOCK_MIGRATION_TOTAL_SIZE = 1_536_000_000; // ~1.5 GB

// Which prop-driven dialog is currently mounted locally (only one at a time).
type LocalDialog =
  | "migration-prompt"
  | "migration-skip"
  | "migration-complete-ok"
  | "migration-complete-fail"
  | "staged-changes"
  | null;

interface Entry {
  label: string;
  hint: string;
  onTrigger: () => void;
}

export default function DevDialogPreview() {
  // Stripped from production bundles — the panel is a dev affordance only.
  if (process.env.NODE_ENV !== "development") return null;
  return <DevDialogPreviewInner />;
}

function DevDialogPreviewInner() {
  const [panelOpen, setPanelOpen] = useState(false);
  const [localDialog, setLocalDialog] = useState<LocalDialog>(null);

  const setMigrationProgress = useSetAtom(migrationProgressAtom);
  const setPendingConflicts = useSetAtom(pendingConflictsAtom);
  const setCreditsExhausted = useSetAtom(creditsExhaustedAtom);
  const setFailedFiles = useSetAtom(failedFilesAtom);

  // Collapse the launcher panel when popping a full-screen dialog so it
  // doesn't sit on top of the thing you're trying to look at.
  const openDialog = (d: LocalDialog) => {
    setLocalDialog(d);
    setPanelOpen(false);
  };

  const banners: Entry[] = [
    {
      label: "Migration Banner",
      hint: "Top-of-page migration progress",
      onTrigger: () => setMigrationProgress(MOCK_MIGRATION_PROGRESS),
    },
    {
      label: "Conflicts Banner",
      hint: "Plus its Review & Resolve dialog",
      onTrigger: () => setPendingConflicts(MOCK_STAGED_CHANGES),
    },
    {
      label: "Credits Exhausted Banner",
      hint: "Out-of-credits / top-up CTA",
      onTrigger: () => setCreditsExhausted(MOCK_CREDITS_EXHAUSTED),
    },
  ];

  const modals: Entry[] = [
    {
      label: "Sync Issues (Failed Files)",
      hint: "Retry / skip / exclude modal",
      onTrigger: () => setFailedFiles(MOCK_FAILED_FILES),
    },
    {
      label: "Staged / Merge Changes",
      hint: "Conflict resolution dialog",
      onTrigger: () => openDialog("staged-changes"),
    },
  ];

  const migration: Entry[] = [
    {
      label: "Migration Prompt",
      hint: "Migrate vs. Start Fresh",
      onTrigger: () => openDialog("migration-prompt"),
    },
    {
      label: "Confirm Skip Migration",
      hint: "Type-DELETE confirmation",
      onTrigger: () => openDialog("migration-skip"),
    },
    {
      label: "Migration Complete (success)",
      hint: "Success summary",
      onTrigger: () => openDialog("migration-complete-ok"),
    },
    {
      label: "Migration Complete (failed)",
      hint: "Failure summary",
      onTrigger: () => openDialog("migration-complete-fail"),
    },
  ];

  // Hide every atom-driven surface and dismiss any local dialog.
  const resetAll = () => {
    setMigrationProgress({ active: false, completed: 0, total: 0 });
    setPendingConflicts(null);
    setCreditsExhausted(null);
    setFailedFiles(null);
    setLocalDialog(null);
  };

  return (
    <>
      {/* Launcher button — fixed bottom-right, above banners. */}
      <button
        type="button"
        onClick={() => setPanelOpen((v) => !v)}
        title="Dialog & banner preview (dev only)"
        aria-label="Open dialog preview panel"
        className={cn(
          "fixed bottom-4 right-4 z-[10000] flex size-11 items-center justify-center rounded-full",
          "bg-primary-50 text-white shadow-lg shadow-black/20 transition-colors hover:bg-primary-40",
        )}
      >
        {panelOpen ? <X className="size-5" /> : <Wrench className="size-5" />}
      </button>

      {panelOpen && (
        <div
          className={cn(
            "fixed bottom-[4.5rem] right-4 z-[10000] flex max-h-[75vh] w-72 flex-col overflow-hidden rounded-xl border shadow-2xl",
            "border-grey-80 bg-white text-grey-10",
            "dark:border-[#2c2c2c] dark:bg-[#161616] dark:text-white",
          )}
        >
          <div className="flex items-center justify-between border-b border-grey-80 px-3 py-2.5 dark:border-[#2c2c2c]">
            <span className="text-sm font-semibold">Dialog Preview</span>
            <span className="rounded bg-grey-90 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-grey-40 dark:bg-[#2c2c2c] dark:text-grey-dark-700">
              dev
            </span>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 [scrollbar-gutter:stable]">
            <Section title="Banners" entries={banners} />
            <Section title="Modals" entries={modals} />
            <Section title="Migration Flow" entries={migration} />
          </div>

          <div className="border-t border-grey-80 p-3 dark:border-[#2c2c2c]">
            <button
              type="button"
              onClick={resetAll}
              className={cn(
                "w-full rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                "border-grey-80 text-grey-30 hover:bg-grey-90",
                "dark:border-[#494949] dark:text-grey-dark-800 dark:hover:bg-[#2c2c2c]",
              )}
            >
              Hide all / Reset
            </button>
          </div>
        </div>
      )}

      {/* Prop-driven dialogs mounted on demand with mock props. */}
      {localDialog === "migration-prompt" && (
        <MigrationPromptDialog
          open
          fileCount={MOCK_MIGRATION_FILE_COUNT}
          totalSize={MOCK_MIGRATION_TOTAL_SIZE}
          onMigrate={() => setLocalDialog(null)}
          onSkip={() => setLocalDialog("migration-skip")}
        />
      )}
      {localDialog === "migration-skip" && (
        <MigrationConfirmSkipDialog
          open
          fileCount={MOCK_MIGRATION_FILE_COUNT}
          onClose={() => setLocalDialog("migration-prompt")}
          onConfirm={() => setLocalDialog(null)}
        />
      )}
      {localDialog === "migration-complete-ok" && (
        <MigrationCompleteDialog
          open
          successCount={MOCK_MIGRATION_FILE_COUNT}
          totalCount={MOCK_MIGRATION_FILE_COUNT}
          migrationSucceeded
          onClose={() => setLocalDialog(null)}
        />
      )}
      {localDialog === "migration-complete-fail" && (
        <MigrationCompleteDialog
          open
          successCount={184}
          totalCount={MOCK_MIGRATION_FILE_COUNT}
          migrationSucceeded={false}
          onClose={() => setLocalDialog(null)}
        />
      )}
      {localDialog === "staged-changes" && (
        <StagedChangesDialog
          open
          stagedChanges={MOCK_STAGED_CHANGES}
          isSyncing={false}
          onClose={() => setLocalDialog(null)}
          onSync={() => setLocalDialog(null)}
          onCancel={() => setLocalDialog(null)}
        />
      )}
    </>
  );
}

function Section({ title, entries }: { title: string; entries: Entry[] }) {
  return (
    <div className="mb-4 last:mb-0">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-grey-50 dark:text-grey-dark-600">
        {title}
      </p>
      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <button
            key={entry.label}
            type="button"
            onClick={entry.onTrigger}
            className={cn(
              "rounded-md border px-3 py-2 text-left transition-colors",
              "border-grey-80 hover:bg-grey-90",
              "dark:border-[#2c2c2c] dark:hover:bg-[#2c2c2c]",
            )}
          >
            <span className="block text-sm font-medium leading-tight text-grey-10 dark:text-white">
              {entry.label}
            </span>
            <span className="mt-0.5 block text-xs text-grey-50 dark:text-grey-dark-700">
              {entry.hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
