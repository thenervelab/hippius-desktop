"use client";

import { FC, ReactNode, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Icons, RefreshButton, SearchInput } from "@/components/ui";
import { cn } from "@/lib/utils";
import AddButton from "./AddFileButton";
import StorageStateList from "./storage-stats";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import FilterChips from "./filter-chips";
import FolderUploadDialog from "./FolderUploadDialog";
import SyncFolderBreadcrumb from "./SyncFolderBreadcrumb";
import { useFilesNavigation } from "@/lib/hooks/useFilesNavigation";

import useNavigationLoader from "@/app/lib/hooks/useNavigationLoader";
import { List } from "lucide-react";
import StartSyncingButton from "@/app/components/StartSyncingButton";
import FilterPills from "./FilterPills";
import { FileTypes } from "@/lib/types/fileTypes";
import { IS_SYNC_PAUSED } from "@/components/ui/SyncPausedAlert";
import { useAtomValue } from "jotai";
import { hasConfiguredDrivesAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { shareFeatureEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { toast } from "sonner";
import { useCreditCheck } from "@/lib/hooks/useCreditCheck";

// Figma white pill style shared by Add Folder / View All Files / Shared Links.
// Mirrors the trigger styling used across the home dashboard cards.
const SECONDARY_PILL_CLASSES = cn(
  "h-[30px] px-3 py-2 gap-[7px] rounded-[6px]",
  "bg-white border border-grey-dark-100 text-black-600",
  "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)]",
  "font-geist text-[14px] font-medium tracking-[-0.28px] leading-[1.109]",
  "hover:bg-grey-light-700",
  "dark:bg-black-primary-bg dark:border-black-300 dark:text-grey-light-200",
  "dark:hover:bg-black-300",
);

const VIEW_TOGGLE_BUTTON_BASE =
  "flex items-center justify-center size-6 rounded-[3px] transition-opacity";

const VIEW_TOGGLE_ACTIVE = cn(
  "bg-grey-light-300 border border-grey-dark-100",
  "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)]",
  "dark:bg-black-primary-bg dark:border-black-300",
);

const VIEW_TOGGLE_INACTIVE = "opacity-50 hover:opacity-75";

interface DriveHeaderProps {
  isRecentFiles?: boolean;
  isRefetching?: boolean;
  isFetching?: boolean;
  formattedStorageSize: string;
  allFilteredDataLength: number;
  viewMode: "list" | "card";
  setViewMode: (mode: "list" | "card") => void;
  searchTerm: string;
  handleSearchChange: (value: string) => void;
  activeFilters: ActiveFilter[];
  handleRemoveFilter: (filter: ActiveFilter) => void;
  refetchUserFiles: () => void;
  addButtonRef: React.RefObject<{
    openWithFiles(files: FileList): Promise<void>;
    openWithPaths(paths: string[]): Promise<void>;
    isDialogOpen(): boolean;
  } | null>;
  privateFileCount?: number;
  publicFileCount?: number;
  isSyncPathEmpty?: boolean;
  onStartSyncing?: () => void;
  hasNoSyncPaths?: boolean;
  onNavigateToSettings?: () => void;
  // New filter props
  selectedFileTypes: FileTypes[];
  selectedDate: string;
  selectedFileSizes: number[];
  onFileTypesChange: (types: FileTypes[]) => void;
  onDateChange: (date: string) => void;
  onFileSizesChange: (sizes: number[]) => void;
  defaultFolderLabel?: string | null;
  isFolderUploadOpen?: boolean;
  onSetFolderUploadOpen?: (open: boolean) => void;
  // Breadcrumb props — rendered as the first line of the drive (non-recent) header.
  // The breadcrumb lives inside DriveHeader so line 1 (breadcrumb + action buttons)
  // and line 2 (filter pills + stats/search/view-mode) can share one flex column.
  folderDisplayName?: string | null;
  onBreadcrumbLocalClick?: () => void;
  // File content (DriveContent). For the drive (non-recent) layout this is
  // rendered INSIDE the inner white card so the card border wraps both the
  // filter row and the file list — matches Figma node 4045:116493.
  children?: ReactNode;
}

const DriveHeader: FC<DriveHeaderProps> = ({
  isRecentFiles = false,
  isRefetching = false,
  isFetching = false,
  formattedStorageSize,
  allFilteredDataLength,
  viewMode,
  setViewMode,
  searchTerm,
  handleSearchChange,
  activeFilters,
  handleRemoveFilter,
  refetchUserFiles,
  addButtonRef,
  isSyncPathEmpty = false,
  onStartSyncing,
  hasNoSyncPaths = false,
  onNavigateToSettings,
  // New filter props
  selectedFileTypes,
  selectedDate,
  selectedFileSizes,
  onFileTypesChange,
  onDateChange,
  onFileSizesChange,
  defaultFolderLabel,
  isFolderUploadOpen: isFolderUploadOpenProp,
  onSetFolderUploadOpen,
  folderDisplayName = null,
  onBreadcrumbLocalClick,
  children,
}) => {
  const [isFolderUploadOpenLocal, setIsFolderUploadOpenLocal] = useState(false);
  const isFolderUploadOpen = isFolderUploadOpenProp ?? isFolderUploadOpenLocal;
  const setIsFolderUploadOpen =
    onSetFolderUploadOpen ?? setIsFolderUploadOpenLocal;
  const hasConfiguredDrives = useAtomValue(hasConfiguredDrivesAtom);
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);
  const { checkEligibility } = useCreditCheck();

  const { navigateToFilesView } = useFilesNavigation();
  const { push } = useNavigationLoader();

  const handleViewAllFiles = () => {
    navigateToFilesView();
    push("/files");
  };

  // Action buttons shared by both header layouts. Hoisted into a const so the
  // recent-files row and the drive row don't fork the gated/conditional logic
  // (Folder Upload eligibility, hasNoSyncPaths disabled fallback, etc.).
  const actionButtons = (
    <>
      {/* Folder Upload button - disabled for recent files with no sync paths or when sync is paused */}
      {(!isRecentFiles || !hasNoSyncPaths) && !isSyncPathEmpty && (
        <Button
          variant="defaultStable"
          size="auto"
          onClick={async () => {
            if (!(await checkEligibility("folder-upload"))) return;
            if (!hasConfiguredDrives) {
              toast.warning(
                "Set up a sync folder in Settings → Sync & Storage before uploading.",
              );
              return;
            }
            setIsFolderUploadOpen(true);
          }}
          disabled={IS_SYNC_PAUSED}
          className={SECONDARY_PILL_CLASSES}
        >
          + New Folder
        </Button>
      )}
      {isRecentFiles && hasNoSyncPaths && (
        <Button
          variant="defaultStable"
          size="auto"
          disabled
          className={SECONDARY_PILL_CLASSES}
        >
          + New Folder
        </Button>
      )}

      {/* Add File button - disabled for recent files with no sync paths or when sync is paused */}
      {isRecentFiles && hasNoSyncPaths ? (
        <Button
          variant="primary"
          size="auto"
          disabled
          className="h-[30px] px-3 py-[10px] gap-[10px] rounded-[6px] font-geist text-[14px] tracking-[-0.28px] leading-[1.109]"
        >
          + Add Files
        </Button>
      ) : (
        !isSyncPathEmpty && (
          <AddButton
            ref={addButtonRef}
            disabled={IS_SYNC_PAUSED}
            defaultFolderLabel={defaultFolderLabel}
          />
        )
      )}

      {/* Start Syncing button - show for empty sync paths or no sync paths */}
      {(isSyncPathEmpty || (isRecentFiles && hasNoSyncPaths)) && (
        <StartSyncingButton
          onClick={
            isRecentFiles && hasNoSyncPaths
              ? onNavigateToSettings
              : onStartSyncing
          }
        />
      )}

      {/* Shared Links navigation — secondary white pill style so it does
          not compete with the primary "Upload File" CTA. Hidden when
          the connected hcfs-server doesn't advertise `shares: true`. */}
      {shareEnabled && (
        <Button
          variant="defaultStable"
          size="auto"
          onClick={() => push("/shares")}
          className={SECONDARY_PILL_CLASSES}
        >
          <Icons.Link className="size-4" />
          Shared Links
        </Button>
      )}
    </>
  );

  const refreshButton = (
    <RefreshButton
      refetching={isRefetching || isFetching}
      className="size-7 rounded-[6px]"
      iconClassName="size-4"
      onClick={() => {
        invoke("trigger_sync_now").catch((err: unknown) =>
          console.warn("[DriveHeader] trigger_sync_now failed:", err),
        );
        refetchUserFiles();
      }}
    />
  );

  const viewModeToggle = (
    <div className="flex items-start gap-1 p-[3px] rounded-[6px] bg-grey-primary-bg dark:bg-black-600">
      <button
        className={cn(
          VIEW_TOGGLE_BUTTON_BASE,
          viewMode === "list" ? VIEW_TOGGLE_ACTIVE : VIEW_TOGGLE_INACTIVE,
        )}
        onClick={() => setViewMode("list")}
        aria-label="List View"
      >
        <List className="size-3 text-black-700 dark:text-white" />
      </button>
      <button
        className={cn(
          VIEW_TOGGLE_BUTTON_BASE,
          viewMode === "card" ? VIEW_TOGGLE_ACTIVE : VIEW_TOGGLE_INACTIVE,
        )}
        onClick={() => setViewMode("card")}
        aria-label="Card View"
      >
        <Icons.Category className="size-3 text-black-700 dark:text-white" />
      </button>
    </div>
  );

  return (
    <>
      {isRecentFiles ? (
        // Recent Files layout — intentionally unchanged. The new Figma-based
        // alignment below applies only to the drive (non-recent) header.
        <div className="flex justify-between items-center w-full gap-6 flex-wrap my-2 px-2.5">
          <h2 className="text-lg font-medium text-grey-10 dark:text-grey-light-100">
            Recent Files
          </h2>
          <div className="flex items-center gap-3 flex-wrap">
            {refreshButton}
            {viewModeToggle}
            <Button
              variant="defaultStable"
              size="auto"
              onClick={handleViewAllFiles}
              className={SECONDARY_PILL_CLASSES}
            >
              View All Files
              <Icons.ArrowRight className="size-[0.875rem]" />
            </Button>
            {actionButtons}
          </div>
        </div>
      ) : (
        // Drive (non-recent) layout — matches Figma node 4045:116493.
        // Structure: outer grey card → top row (breadcrumb + buttons) → inner
        // white card containing the filter row (border-b), filter chips, and
        // the file content (passed in as children).
        <div
          className={cn(
            "w-full flex flex-col items-stretch",
            "bg-grey-light-300 border border-grey-dark-100 rounded-[8px]",
            "shadow-[0px_1px_1.1px_0px_rgba(0,0,0,0.04)]",
            "dark:bg-black-primary-bg dark:border-black-300",
            "dark:shadow-[0px_1px_1.1px_0px_rgba(0,0,0,0.4)]",
          )}
        >
          {/* Line 1 — Breadcrumb (left) | Refresh + New Folder + Add File + … (right).
              Lives inside the outer grey card's top section (px-2.5 py-2 per Figma).
              The default mt-6/mb-5 from SyncFolderBreadcrumb is overridden so the
              row stays compact and vertically aligned with the buttons. */}
          <div className="flex items-center justify-between gap-4 flex-wrap min-w-0 w-full px-2.5 py-2">
            <SyncFolderBreadcrumb
              folderDisplayName={folderDisplayName}
              onLocalClick={onBreadcrumbLocalClick ?? (() => {})}
              className="mt-0 mb-0"
            />
            <div className="flex items-center gap-3 flex-wrap">
              {refreshButton}
              {actionButtons}
            </div>
          </div>

          {/* Inner white card — wraps the filter row, chips, and file content. */}
          <div
            className={cn(
              "w-full flex flex-col gap-2 pb-2.5",
              "bg-white border border-grey-dark-100 rounded-[8px]",
              "dark:bg-black-primary-bg dark:border-black-300",
            )}
          >
            {/* Filter / stats section — shares one container with a bottom
                border that separates it from the file content below. Stacks
                vertically so the active filter chips sit BELOW the pills row
                but ABOVE the border (per Figma + UX request). */}
            <div className="w-full flex flex-col gap-3 p-3 border-b border-grey-dark-100 dark:border-black-300">
              {/* Line 2 — Filter pills (left) | stats + search + view-mode (right). */}
              <div className="flex items-center justify-between w-full gap-3 flex-wrap">
                <FilterPills
                  selectedFileTypes={selectedFileTypes}
                  selectedDate={selectedDate}
                  selectedFileSizes={selectedFileSizes}
                  onFileTypesChange={onFileTypesChange}
                  onDateChange={onDateChange}
                  onFileSizesChange={onFileSizesChange}
                />
                <div className="flex items-center gap-3 shrink-0">
                  <StorageStateList
                    storageUsed={formattedStorageSize}
                    numberOfFiles={allFilteredDataLength || 0}
                  />
                  <SearchInput
                    value={searchTerm}
                    onChange={handleSearchChange}
                    placeholder="Search file"
                  />
                  {viewModeToggle}
                </div>
              </div>

              {/* Line 3 — Active filter chips. Inside the same bordered
                  container as the pills row, above the bottom border. */}
              {activeFilters.length > 0 && (
                <FilterChips
                  filters={activeFilters}
                  onRemoveFilter={handleRemoveFilter}
                />
              )}
            </div>

            {/* File content (DriveContent) — sits inside the inner white card so
                the card border wraps the list/grid along with the filter row. */}
            {children && <div className="px-2.5">{children}</div>}
          </div>
        </div>
      )}

      {/* Folder Upload Dialog */}
      <FolderUploadDialog
        open={isFolderUploadOpen}
        onClose={() => setIsFolderUploadOpen(false)}
        onRefresh={refetchUserFiles}
        defaultFolderLabel={defaultFolderLabel}
      />
    </>
  );
};

export default DriveHeader;
