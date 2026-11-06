"use client";

import type { SortingState } from "@tanstack/react-table";

import { FC, useEffect, useCallback, memo, useMemo } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import FilesTable from "./files-table";
import FilesTableSkeleton from "./files-table/FilesTableSkeleton";
import CardViewSkeleton from "./card-view/CardViewSkeleton";
import CardView from "./card-view";
import FilesNoEntriesFound from "./files-table/FilesNoEntriesFound";
import DriveEmptyStatePlans from "@/components/page-sections/drive-plans/DriveEmptyStatePlans";
import UploadStatusWidget from "./UploadStatusWidget";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import ConfirmationDialog from "@/app/components/ConfirmationDialog";
import { Trash2 } from "lucide-react";
import { UnifiedMediaDialog } from "./file-preview";
import { toast } from "sonner";
import { useFileViewShared } from "./shared/FileViewUtils";
import FileContextMenu from "@/app/components/ui/context-menu";
import { useRemoteFileUpload, useRemoteFolderUpload } from "@/app/lib/hooks/useRemoteUploadActions";
import type { NewFolderTarget } from "@/app/lib/global-atoms/contextMenuAtoms";
import { formatDisplayName } from "@/lib/utils/fileTypeUtils";
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import NoMatchingResults from "./NoMatchingResults";
import { useSetAtom } from "jotai";
import { shareModalFileAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { shareTargetFor } from "@/app/lib/utils/folderShareGating";
import { renameModalFileAtom } from "@/app/lib/global-atoms/renameAtoms";
import { downloadFile } from "@/app/lib/utils/downloadFile";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import usePageContextActions from "@/app/lib/hooks/usePageContextActions";
import { useDriveRoute } from "./driveRoute";
import { deleteShareLinksNote } from "./deleteShareLinksNote";

interface DriveContentProps {
  isRecentFiles?: boolean;
  isLoading: boolean;
  filteredData: Array<FormattedUserFile & { timestamp?: Date | null }>;
  displayedData: Array<FormattedUserFile & { timestamp?: Date | null }>;
  searchTerm: string;
  activeFilters: ActiveFilter[];
  viewMode: "list" | "card";
  error?: unknown;
  hasMore: boolean;
  loadMore: () => void;
  /** A remote server page is being fetched — renders a skeleton strip under
   *  the rows so scroll-driven appends never look stalled. */
  isLoadingMore?: boolean;
  /** Rows in the loading skeleton. Defaults to the pre-paging count. */
  skeletonRows?: number;
  sorting?: SortingState;
  onSortingChange?: (next: SortingState) => void;
  serverSorted?: boolean;
  /** Where the rendered window starts in the sorted list. See FilesTable. */
  windowStart?: number;
  /** Receives the level in the order the table sorts it (list view only). */
  onSortedLevel?: (source: readonly FormattedUserFile[], rows: readonly FormattedUserFile[]) => void;
  isSyncPathEmpty?: boolean;
  /** True when the user has insufficient credits to upload files.
   *  Swaps the empty-state into the "Add Credits" variant. */
  isStorageFull?: boolean;
  /** Browsing a remote (server-only) drive — uploads are not supported
   *  there yet, so the empty state renders without an upload CTA. */
  isRemoteView?: boolean;
  /** The typed term is too short for the server-side search that backs this
   *  view, so the empty list means "not searched", not "no matches". */
  searchTermTooShort?: boolean;
  onSyncPathConfigured?: () => void;
  onUploadFile?: () => void;
  onAddFolder?: () => void;
  onAddSyncFolder?: () => void;
  drivePathsByLabel?: Record<string, string>;
  currentSubfolderPath?: string | null;
  /** Where the menu's New Folder creates; defaults to the main drive. */
  newFolderTarget?: NewFolderTarget;
  /**
   * Show the Added by column in list view. Same gate as the Added by
   * filter: only inside a shared drive (or shared folder context).
   */
  showUploadedBy?: boolean;
  driveOwnerSs58?: string;
  driveOwnerName?: string;
}

const DriveContent: FC<DriveContentProps> = ({
  isRecentFiles = false,
  isLoading,
  filteredData,
  displayedData,
  searchTerm,
  activeFilters,
  viewMode,
  error,
  hasMore,
  loadMore,
  isLoadingMore = false,
  skeletonRows,
  sorting,
  onSortingChange,
  serverSorted,
  windowStart,
  onSortedLevel,
  isSyncPathEmpty = false,
  isStorageFull = false,
  isRemoteView = false,
  searchTermTooShort = false,
  onSyncPathConfigured,
  onUploadFile,
  onAddFolder,
  onAddSyncFolder,
  drivePathsByLabel,
  currentSubfolderPath,
  newFolderTarget,
  showUploadedBy = false,
  driveOwnerSs58,
  driveOwnerName,
}) => {
  // Opens `ShareFileModal` (mounted at the layout level) for the
  // selected file. Setting the atom is the only handoff — the modal
  // owns its own lifecycle from there.
  const setShareModalFile = useSetAtom(shareModalFileAtom);
  // Same handoff for `RenameDialog` (also mounted at the layout level).
  const setRenameModalFile = useSetAtom(renameModalFileAtom);
  // The page's own empty state for a pinned drive's root (Captures).
  const { pinned, emptyState: pinnedEmptyState } = useDriveRoute();

  // Use selection context for delete functionality
  const { enterSelectionModeAndSelectFile } = useFileSelection();

  // Use shared functionality between FilesTable and CardView
  const sharedState = useFileViewShared();

  const {
    fileToDelete,
    setFileToDelete,
    openDeleteModal,
    setOpenDeleteModal,
    selectedFile,
    setSelectedFile,
    previewList,
    fileDetailsFile,
    setFileDetailsFile,
    deleteFile,
    isDeleting,
    contextMenu,
    setContextMenu,
  } = sharedState;

  // The viewer's gallery scope: a file opened from an inline-expanded folder
  // carries that folder's rows as `previewList`, so its thumbnail rail and
  // prev/next walk the folder it lives in — not the page's top-level list.
  const viewerFiles = previewList ?? filteredData;
  // Strip/arrow navigation stays within the current scope: re-pass the list
  // so `setSelectedFile` (which pairs file + list atomically) keeps it.
  const handleViewerNavigate = useCallback(
    (file: FormattedUserFile) => setSelectedFile(file, previewList),
    [setSelectedFile, previewList],
  );

  // Re-sync the panel atom with the freshest copy from `filteredData`.
  // The atom snapshot can get stale (e.g. arion hash arrives after the panel
  // opens), so when filteredData updates we push the live row back in.
  useEffect(() => {
    if (!fileDetailsFile) return;
    const live = filteredData.find(
      (f) =>
        f.actualFileName === fileDetailsFile.actualFileName &&
        f.label === fileDetailsFile.label,
    );
    if (live && live !== fileDetailsFile) {
      setFileDetailsFile(live);
    }
  }, [filteredData, fileDetailsFile, setFileDetailsFile]);

  // Files dropped from the OS are handled once for the whole window by
  // `OsDropHost`; DriveContainer tells it where this view's drops go.

  const handleFileDownload = (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => {
    downloadFile(file, polkadotAddress);
  };

  // What the right-click menu offers while this view is on screen. The
  // menu is mounted once in the pages layout — registering handlers rather
  // than rendering a menu here is what gives every surface one, including
  // those that never had a background menu (Overview, the drive list), and
  // guarantees the menu and this view's toolbar run the same action
  // against the same folder.
  //
  // Uploads are withheld where they cannot work: a drive with no sync path
  // has nowhere to put the file. New Folder is not — with no folder open
  // it falls back to the main drive's root.
  // Route the refresh through the shared funnel: it wakes the cached
  // lists AND the nested folder listings, which only react to the window
  // event.
  const uploadQueryClient = useQueryClient();
  const { polkadotAddress: uploadAccount } = useWalletAuth();
  const refreshAfterRemoteUpload = useCallback(() => {
    void notifyFilesMutated(uploadQueryClient, uploadAccount);
  }, [uploadQueryClient, uploadAccount]);

  // A browsed drive has no local sync root, so the local upload handlers
  // are withheld from this view — which left its menu with nothing but
  // New Folder. Its uploads go straight to the server instead, through
  // the same actions the remote toolbar buttons run.
  const remoteTarget = newFolderTarget?.kind === "remote" ? newFolderTarget : null;
  const remoteFile = useRemoteFileUpload({
    label: remoteTarget?.label ?? null,
    parentPath: remoteTarget?.parentPath,
    onUploaded: refreshAfterRemoteUpload,
  });
  const remoteFolder = useRemoteFolderUpload({
    label: remoteTarget?.label ?? null,
    parentPath: remoteTarget?.parentPath,
    onUploaded: refreshAfterRemoteUpload,
  });

  const canUpload = !isSyncPathEmpty && Boolean(onUploadFile);
  const contextActions = useMemo(
    () => ({
      onUploadFile: remoteTarget
        ? () => {
            if (isStorageFull) return;
            remoteFile.start();
          }
        : canUpload
          ? onUploadFile
          : undefined,
      onUploadFolder: remoteTarget
        ? () => {
            if (isStorageFull) return;
            remoteFolder.start();
          }
        : canUpload
          ? onAddFolder
          : undefined,
      // Only where drives are chosen — the drive list and Recent Files.
      // Inside a drive, local or remote, "Sync a Folder" answers a
      // question the user is no longer asking, and registering a NEW sync
      // folder from inside another one reads as doing something to the
      // folder they are looking at.
      onSyncFolder: isRecentFiles ? onAddSyncFolder : undefined,
      uploadsBlocked: isStorageFull,
      newFolderTarget,
    }),
    [
      remoteTarget,
      remoteFile.start,
      remoteFolder.start,
      canUpload,
      onUploadFile,
      onAddFolder,
      isRecentFiles,
      onAddSyncFolder,
      newFolderTarget,
      isStorageFull,
    ],
  );
  usePageContextActions(contextActions);

  const renderContent = () => {
    // Only show full loading state on initial load (no data yet).
    // During background refetches (isFetching), keep showing existing data.
    if (isLoading) {
      return viewMode === "card" ? (
        <CardViewSkeleton
          isRecentFiles={isRecentFiles}
          cards={skeletonRows ?? (isRecentFiles ? 4 : 8)}
        />
      ) : (
        <FilesTableSkeleton
          isRecentFiles={isRecentFiles}
          rows={skeletonRows ?? (isRecentFiles ? 5 : 8)}
          showUploadedBy={showUploadedBy}
        />
      );
    }

    if (
      (!filteredData.length && !searchTerm && activeFilters.length === 0) ||
      error
    ) {
      if (pinned && pinnedEmptyState && !error && !currentSubfolderPath) {
        return <>{pinnedEmptyState}</>;
      }
      return (
        <>
          <FilesNoEntriesFound
            isRecentFiles={isRecentFiles}
            isSyncPathConfigured={!isSyncPathEmpty}
            isStorageFull={isStorageFull}
            isRemoteView={isRemoteView}
            onStartSyncing={onSyncPathConfigured}
          />
          {/* An account with no files and no plan is offered the plans right
              here. The component decides that for itself and renders nothing
              for anyone who already holds one. Recent-files and remote views
              are not the user's own empty drive, so they never show it. */}
          {!isRecentFiles && !isRemoteView && !error ? (
            <DriveEmptyStatePlans className="mt-6" />
          ) : null}
        </>
      );
    }

    if (!filteredData.length && (searchTerm || activeFilters.length > 0)) {
      const hasActiveFilters = activeFilters.length > 0;
      const hasSearchTerm = Boolean(searchTerm && searchTerm.trim());

      return (
        <NoMatchingResults
          searchTerm={hasSearchTerm ? searchTerm : undefined}
          hasActiveFilters={hasActiveFilters}
          searchTermTooShort={searchTermTooShort}
        />
      );
    }

    // While the next remote page is on the wire, `isLoadingMore` is passed
    // INTO the table/grid so the placeholders render inside the real
    // tbody/grid — columns, striping, chevron gutter and grid cells line up
    // with the loaded rows by construction (skeletons for content loading,
    // never a centered spinner and never bare full-width bars).
    if (viewMode === "list") {
      return (
        <>
          <FilesTable
            isRecentFiles={isRecentFiles}
            files={displayedData}
            allFiles={filteredData}
            sorting={sorting}
            onSortingChange={onSortingChange}
            serverSorted={serverSorted}
            windowStart={windowStart}
            onSortedLevel={onSortedLevel}
            handleFileDownload={handleFileDownload}
            sharedState={sharedState}
            hasMore={hasMore}
            loadMore={loadMore}
            isLoadingMore={isLoadingMore}
            drivePathsByLabel={drivePathsByLabel}
            currentSubfolderPath={currentSubfolderPath}
            searchTerm={searchTerm}
            activeFilterCount={activeFilters.length}
            showUploadedBy={showUploadedBy}
            driveOwnerSs58={driveOwnerSs58}
            driveOwnerName={driveOwnerName}
          />
        </>
      );
    } else {
      return (
        <>
          <CardView
            isRecentFiles={isRecentFiles}
            files={displayedData}
            handleFileDownload={handleFileDownload}
            sharedState={sharedState}
            hasMore={hasMore}
            loadMore={loadMore}
            isLoadingMore={isLoadingMore}
            currentSubfolderPath={currentSubfolderPath}
          />
        </>
      );
    }
  };
  return (
    <>
      <div
        className={cn(
          "w-full relative select-none",
          viewMode === "card" && filteredData.length > 0 && "px-2.5",
          viewMode === "card" &&
            filteredData.length > 0 &&
            !isRecentFiles &&
            "mt-[11px]",
          isRecentFiles && "-mt-3",
        )}
      >
        {renderContent()}
      </div>

      <ConfirmationDialog
        open={openDeleteModal}
        onClose={() => {
          setOpenDeleteModal(false);
          setFileToDelete(null);
        }}
        onBack={() => {
          setOpenDeleteModal(false);
          setFileToDelete(null);
        }}
        onConfirm={() => {
          setOpenDeleteModal(false);

          // Format the filename using the same logic as NameCell
          const truncatedName = fileToDelete?.name
            ? formatDisplayName(fileToDelete.name)
            : fileToDelete?.isFolder
              ? "folder"
              : "file";

          const toastId = toast.loading(`Deleting ${truncatedName}...`);

          setTimeout(() => {
            deleteFile()
              .then(() => {
                toast.success(`${truncatedName} deleted successfully.`, {
                  id: toastId,
                });
                setFileToDelete(null);
              })
              .catch((error) => {
                console.error("Delete error:", error);
                toast.error(
                  error.message || `Failed to delete ${truncatedName}`,
                  { id: toastId },
                );
              });
          }, 2000);
        }}
        button={
          isDeleting
            ? "Deleting..."
            : `Delete ${fileToDelete?.isFolder ? "Folder" : "File"}`
        }
        text={
          <>
            Are you sure you want to delete
            {fileToDelete?.name ? (
              <>
                <br />
                {fileToDelete.name}
              </>
            ) : null}
            ?
          </>
        }
        helperText={deleteShareLinksNote(fileToDelete ? [fileToDelete] : [])}
        heading={`Delete ${fileToDelete?.isFolder ? "Folder" : "File"}`}
        icon={<Trash2 className="size-[18px] text-white" strokeWidth={2.5} />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        disableButton={isDeleting}
        disableBackButton={isDeleting}
      />

      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          onClose={() => setContextMenu(null)}
          onDelete={(file) => {
            // Use new selection system instead of old modal system
            enterSelectionModeAndSelectFile(file);
            setContextMenu(null);
          }}
          onFileDownload={handleFileDownload}
          onSelectFile={(file) => {
            setSelectedFile(file, contextMenu.previewList ?? null);
            setContextMenu(null);
          }}
          onShowFileDetails={(file) => {
            setFileDetailsFile(file);
            setContextMenu(null);
          }}
          onShareFile={(file) => {
            setShareModalFile(shareTargetFor(file, currentSubfolderPath));
            setContextMenu(null);
          }}
          onRename={(file) => {
            setRenameModalFile(file);
            setContextMenu(null);
          }}
          basePath={currentSubfolderPath}
        />
      )}

      {/* One dialog for every previewable type. It renders nothing when
          `selectedFile` is null, so the page keeps a single viewer state. */}
      <UnifiedMediaDialog
        onCloseClicked={() => setSelectedFile(null)}
        handleFileDownload={handleFileDownload}
        file={selectedFile}
        allFiles={viewerFiles}
        onNavigate={handleViewerNavigate}
      />

      <UploadStatusWidget />
    </>
  );
};

export default memo(DriveContent);
