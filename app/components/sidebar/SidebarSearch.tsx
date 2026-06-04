import cn from "@/app/lib/utils/cn";
import { Icons } from "@/components/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import SearchShortcutHint from "./SearchShortcutHint";
import SidebarSearchModal from "./SidebarSearchModal";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import VideoDialog from "@/app/components/page-sections/drive/files-table/VideoDialog";
import ImageDialog from "@/app/components/page-sections/drive/files-table/ImageDialog";
import PdfDialog from "@/app/components/page-sections/drive/files-table/PdfDialog";
import { downloadFile } from "@/app/lib/utils/downloadFile";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { FileSelectionProvider } from "@/app/contexts/FileSelectionContext";
import { useDeleteFile } from "@/app/lib/hooks/use-delete-file";
import ConfirmationDialog from "@/app/components/ConfirmationDialog";
import { Trash2 } from "lucide-react";

interface SidebarSearchProps {
  collapsed?: boolean;
}

// The sidebar field is now a trigger: clicking it (or ⌘/Ctrl+F) opens a
// screen-centered command palette (`SidebarSearchModal`) instead of an
// anchored dropdown. The palette owns the query, the cross-drive search, and
// the "last uploads" empty state; this component only owns the trigger chrome
// and the preview dialogs a selected file opens into.
const SidebarSearch: React.FC<SidebarSearchProps> = ({ collapsed = false }) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<FormattedUserFile | null>(
    null,
  );
  // The list the selected file was chosen from, handed to the preview dialog
  // so prev/next navigation walks the same set the user was looking at.
  const [previewList, setPreviewList] = useState<FormattedUserFile[]>([]);

  const { polkadotAddress } = useWalletAuth();

  // Resolve which preview dialog to render for the selected file. Mirrors
  // `getFileType` in `useFileViewShared`: name → extension → FileType. Only
  // video/image/PDF have a preview dialog; anything else is a no-op.
  const selectedFileType = useMemo(() => {
    if (!selectedFile) return null;
    const { fileFormat } = getFilePartsFromFileName(selectedFile.name);
    return getFileTypeFromExtension(fileFormat || null);
  }, [selectedFile]);

  // ⌘/Ctrl+F opens the palette from anywhere, regardless of whether the
  // sidebar is collapsed — the palette is a centered overlay and no longer
  // depends on the sidebar input being visible.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f") return;
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Open the search palette when the tray popover's "Search Files" field is
  // clicked. The popover is a separate webview, so it emits this event instead
  // of reaching into the sidebar. The field is now a trigger for the centered
  // command palette, so we open that palette — same as ⌘/Ctrl+F above.
  useEffect(() => {
    const unlisten = listen("hippius:tray-focus-search", () => {
      setSearchOpen(true);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const handleSelect = useCallback(
    (file: FormattedUserFile, list: FormattedUserFile[]) => {
      setSelectedFile(file);
      setPreviewList(list);
      setSearchOpen(false);
    },
    [],
  );

  const handleClosePreview = useCallback(() => setSelectedFile(null), []);

  const handleFileDownload = useCallback(
    (file: FormattedUserFile, address: string) => {
      downloadFile(file, address);
    },
    [],
  );

  // Delete from the preview viewer. The drive page routes its viewer delete
  // through selection mode + the bottom action bar; the sidebar has neither, so
  // it deletes directly through the SAME `delete_files` call (`useDeleteFile`)
  // behind its own confirm dialog.
  const [fileToDelete, setFileToDelete] = useState<FormattedUserFile | null>(
    null,
  );
  const deleteMutation = useDeleteFile({
    files: fileToDelete ? [fileToDelete] : [],
  });
  const isDeleting = deleteMutation.isPending;

  const handleViewerDelete = useCallback((file: FormattedUserFile) => {
    setSelectedFile(null); // close the viewer; the confirm dialog takes over
    setFileToDelete(file);
  }, []);

  const closeDeleteConfirm = useCallback(() => {
    if (isDeleting) return;
    setFileToDelete(null);
  }, [isDeleting]);

  const handleConfirmDelete = useCallback(() => {
    deleteMutation.mutate(undefined, {
      onSettled: () => setFileToDelete(null),
    });
  }, [deleteMutation]);

  return (
    <>
      {collapsed ? (
        <button
          type="button"
          aria-label="Search Files"
          aria-haspopup="dialog"
          onClick={() => setSearchOpen(true)}
          className={cn(
            "flex items-center w-full rounded-[12px] bg-[#0000000F] p-[10px] text-[#1111114D] transition-colors overflow-hidden",
            "hover:bg-[#00000014] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#1111111A]",
            "dark:bg-[#FFFFFF0F] dark:text-white/30 dark:hover:bg-white/10 dark:focus-visible:ring-white/10",
          )}
        >
          <span className="size-[18px] flex-shrink-0 flex items-center justify-center">
            <Icons.Search className="size-[18px]" />
          </span>
        </button>
      ) : (
        <button
          type="button"
          aria-label="Search Files"
          aria-haspopup="dialog"
          onClick={() => setSearchOpen(true)}
          className={cn(
            "flex items-center gap-2 w-full rounded-[12px] bg-[#0000000F] px-3 py-2 text-left",
            "transition-colors hover:bg-[#00000014] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#1111111f]",
            "dark:bg-[#FFFFFF0F] dark:hover:bg-white/10 dark:focus-visible:ring-inset dark:focus-visible:ring-white/10",
          )}
        >
          <span className="size-[18px] flex-shrink-0 flex items-center justify-center text-[#1111114D] dark:text-white/30">
            <Icons.Search className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1 text-[14px] leading-5 font-medium text-[#1111114D] dark:text-white/30">
            Search Files
          </span>
          <SearchShortcutHint />
        </button>
      )}

      {searchOpen && (
        <SidebarSearchModal
          onClose={() => setSearchOpen(false)}
          accountId={polkadotAddress}
          onSelect={handleSelect}
        />
      )}

      {/* Preview dialogs mirror DriveContent's mount pattern: one dialog per
          type, gated on `selectedFileType`. The provider is required because
          `FileViewerLayout` (inside each dialog) calls `useFileSelection`,
          which throws when no provider is in scope. A local sidebar-scoped
          instance keeps selection state isolated from the drive page. */}
      {selectedFileType && (
        <FileSelectionProvider>
          {selectedFileType === "video" && (
            <VideoDialog
              file={selectedFile}
              allFiles={previewList}
              onCloseClicked={handleClosePreview}
              onNavigate={setSelectedFile}
              handleFileDownload={handleFileDownload}
              onDelete={handleViewerDelete}
            />
          )}
          {selectedFileType === "image" && (
            <ImageDialog
              file={selectedFile}
              allFiles={previewList}
              onCloseClicked={handleClosePreview}
              onNavigate={setSelectedFile}
              handleFileDownload={handleFileDownload}
              onDelete={handleViewerDelete}
            />
          )}
          {selectedFileType === "PDF" && (
            <PdfDialog
              file={selectedFile}
              allFiles={previewList}
              onCloseClicked={handleClosePreview}
              onNavigate={setSelectedFile}
              handleFileDownload={handleFileDownload}
              onDelete={handleViewerDelete}
            />
          )}
        </FileSelectionProvider>
      )}

      {/* Direct delete for a previewed search result — same `delete_files`
          backend call the drive page uses, just triggered without the
          selection-mode action bar (which the sidebar doesn't render). */}
      {fileToDelete && (
        <ConfirmationDialog
          open={!!fileToDelete}
          onClose={closeDeleteConfirm}
          onBack={closeDeleteConfirm}
          onConfirm={handleConfirmDelete}
          heading="Delete File"
          text={
            <>
              Are you sure you want to delete &quot;
              {fileToDelete.actualFileName || fileToDelete.name}&quot;? This
              action cannot be undone.
            </>
          }
          button={isDeleting ? "Deleting..." : "Delete File"}
          icon={<Trash2 className="size-[18px] text-white" strokeWidth={2.5} />}
          iconBgColor="bg-[#fc7d73]"
          confirmVariant="destructive"
          disableButton={isDeleting}
          disableBackButton={isDeleting}
        />
      )}
    </>
  );
};

export default SidebarSearch;
