"use client";

import { FC, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Icons, RefreshButton, SearchInput } from "@/components/ui";
import { cn } from "@/lib/utils";
import AddButton from "./AddFileButton";
import StorageStateList from "./storage-stats";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import FilterChips from "./filter-chips";
import FolderUploadDialog from "./FolderUploadDialog";
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
  "dark:bg-black-300 dark:border-black-300 dark:text-white",
  "dark:shadow-[0px_5px_2.3px_0px_rgba(255,255,255,0.02),0px_1px_1.9px_0px_rgba(255,255,255,0.08),0px_0px_1px_0px_rgba(255,255,255,0.1)]",
  "dark:hover:bg-black-300/70",
);

const VIEW_TOGGLE_BUTTON_BASE =
  "flex items-center justify-center size-6 rounded-[3px] transition-opacity";

const VIEW_TOGGLE_ACTIVE = cn(
  "bg-grey-light-300 border border-grey-dark-100",
  "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)]",
  "dark:bg-black-300 dark:border-black-300",
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

  return (
    <>
      {!isRecentFiles && (
        <div className="flex items-center justify-between gap-4 flex-wrap min-w-0">
          <StorageStateList
            storageUsed={formattedStorageSize}
            numberOfFiles={allFilteredDataLength || 0}
          />
          <div className="flex items-center gap-2 shrink-0">
            <SearchInput
              className="h-9"
              value={searchTerm}
              onChange={handleSearchChange}
              placeholder="Search file"
            />
            <div className="flex items-start gap-1 p-[3px] rounded-[6px] bg-grey-primary-bg dark:bg-black-700">
              <button
                className={cn(
                  VIEW_TOGGLE_BUTTON_BASE,
                  viewMode === "list"
                    ? VIEW_TOGGLE_ACTIVE
                    : VIEW_TOGGLE_INACTIVE,
                )}
                onClick={() => setViewMode("list")}
                aria-label="List View"
              >
                <List className="size-3 text-black-700 dark:text-white" />
              </button>
              <button
                className={cn(
                  VIEW_TOGGLE_BUTTON_BASE,
                  viewMode === "card"
                    ? VIEW_TOGGLE_ACTIVE
                    : VIEW_TOGGLE_INACTIVE,
                )}
                onClick={() => setViewMode("card")}
                aria-label="Card View"
              >
                <Icons.Category className="size-3 text-black-700 dark:text-white" />
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="flex justify-between items-center w-full gap-6 flex-wrap mt-4">
        {isRecentFiles ? (
          <h2 className="text-lg font-medium text-grey-10">Recent Files</h2>
        ) : (
          <FilterPills
            selectedFileTypes={selectedFileTypes}
            selectedDate={selectedDate}
            selectedFileSizes={selectedFileSizes}
            onFileTypesChange={onFileTypesChange}
            onDateChange={onDateChange}
            onFileSizesChange={onFileSizesChange}
          />
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <RefreshButton
            refetching={isRefetching || isFetching}
            onClick={() => {
              invoke("trigger_sync_now").catch((err: unknown) =>
                console.warn("[DriveHeader] trigger_sync_now failed:", err),
              );
              refetchUserFiles();
            }}
          />
          {isRecentFiles && (
            <>
              <div className="flex items-start gap-1 p-[3px] rounded-[6px] bg-grey-primary-bg dark:bg-black-700">
                <button
                  className={cn(
                    VIEW_TOGGLE_BUTTON_BASE,
                    viewMode === "list"
                      ? VIEW_TOGGLE_ACTIVE
                      : VIEW_TOGGLE_INACTIVE,
                  )}
                  onClick={() => setViewMode("list")}
                  aria-label="List View"
                >
                  <List className="size-3 text-black-700 dark:text-white" />
                </button>
                <button
                  className={cn(
                    VIEW_TOGGLE_BUTTON_BASE,
                    viewMode === "card"
                      ? VIEW_TOGGLE_ACTIVE
                      : VIEW_TOGGLE_INACTIVE,
                  )}
                  onClick={() => setViewMode("card")}
                  aria-label="Card View"
                >
                  <Icons.Category className="size-3 text-black-700 dark:text-white" />
                </button>
              </div>
              <Button
                variant="defaultStable"
                size="auto"
                onClick={handleViewAllFiles}
                className={SECONDARY_PILL_CLASSES}
              >
                View All Files
                <Icons.ArrowRight className="size-[0.875rem]" />
              </Button>
            </>
          )}

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
                      "Set up a sync folder in Settings \u2192 Sync & Storage before uploading.",
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
        </div>
      </div>

      {/* Active Filters Display */}
      {activeFilters.length > 0 && !isRecentFiles && (
        <FilterChips
          filters={activeFilters}
          onRemoveFilter={handleRemoveFilter}
          className="mt-4 mb-2"
        />
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
