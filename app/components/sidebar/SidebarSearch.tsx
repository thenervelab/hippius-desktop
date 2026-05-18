import cn from "@/app/lib/utils/cn";
import { Icons } from "@/components/ui";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useAtomValue, useSetAtom } from "jotai";
import { sidebarCollapsedAtom } from "./sideBarAtoms";
import Command from "../ui/icons/Command";
import SidebarSearchMenu from "./SidebarSearchMenu";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { driveStatusesAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { useGlobalRecursiveFileSearch } from "@/app/lib/hooks/useGlobalRecursiveFileSearch";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import VideoDialog from "@/app/components/page-sections/drive/files-table/VideoDialog";
import ImageDialog from "@/app/components/page-sections/drive/files-table/ImageDialog";
import PdfDialog from "@/app/components/page-sections/drive/files-table/PdfDialog";
import { downloadFile } from "@/app/lib/utils/downloadFile";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { FileSelectionProvider } from "@/app/contexts/FileSelectionContext";

// The dropdown is portalled to <body> so the sidebar's `overflow-hidden`
// (and inner scroll container's `overflow-x-hidden`) can't clip the
// wider-than-the-sidebar results panel. Position is computed from the
// input shell's bounding box and refreshed on scroll/resize.
interface AnchorRect {
  top: number;
  left: number;
}

interface SidebarSearchProps {
  collapsed?: boolean;
}

const SidebarSearch: React.FC<SidebarSearchProps> = ({ collapsed = false }) => {
  const [value, setValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<AnchorRect | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputShellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const focusOnNextExpandRef = useRef(false);
  const hasValue = value.trim().length > 0;

  const { polkadotAddress } = useWalletAuth();
  const driveStatuses = useAtomValue(driveStatusesAtom);

  // Locally-mounted preview dialog state — same shape DriveContent uses
  // in `useFileViewShared`. We keep it sidebar-local instead of moving
  // these dialogs to a global mount because the dialogs need `allFiles`
  // for prev/next navigation, and the natural "all files" here is the
  // current search result set.
  const [selectedFile, setSelectedFile] = useState<FormattedUserFile | null>(
    null,
  );

  // Search every configured drive in parallel and merge — sidebar is
  // outside any drive context, so we can't lean on `activeSyncFolderLabel`
  // the way DriveContainer does.
  const labels = useMemo(
    () => Array.from(driveStatuses.keys()),
    [driveStatuses],
  );
  const { data: results, isFetching } = useGlobalRecursiveFileSearch({
    accountId: polkadotAddress,
    labels,
    criteria: { searchTerm: value },
    enabled: menuOpen && hasValue,
  });

  // Resolve which preview dialog to render for the selected file.
  // Mirrors `getFileType` in `useFileViewShared`: name → extension →
  // FileType. Only video/image/PDF have a preview dialog; everything
  // else closes the menu without opening anything (consistent with the
  // drive view where a non-previewable row click does nothing).
  const selectedFileType = useMemo(() => {
    if (!selectedFile) return null;
    const { fileFormat } = getFilePartsFromFileName(selectedFile.name);
    return getFileTypeFromExtension(fileFormat || null);
  }, [selectedFile]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f") return;
      if (!event.ctrlKey && !event.metaKey) return;

      event.preventDefault();
      if (collapsed) {
        focusOnNextExpandRef.current = true;
        setSidebarCollapsed(false);
        return;
      }
      if (!inputRef.current) return;
      inputRef.current.focus();
      inputRef.current.select();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [collapsed, setSidebarCollapsed]);

  useEffect(() => {
    if (!collapsed && focusOnNextExpandRef.current) {
      focusOnNextExpandRef.current = false;
      inputRef.current?.focus();
    }
  }, [collapsed]);

  // Outside-click / Escape to close. The dropdown is portalled to <body>
  // so a click inside it is not a descendant of `containerRef` — we have
  // to check the menu ref separately, otherwise selecting a result would
  // bubble up to the document listener and close the menu before the
  // button's onClick fires.
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  // Track the input shell's viewport rect so the portalled menu can
  // align under it. Recomputed on open and on any scroll/resize that
  // could move the shell. `useLayoutEffect` so the first paint of the
  // portal already has its coordinates instead of flashing at 0,0.
  useLayoutEffect(() => {
    if (!menuOpen) {
      setAnchorRect(null);
      return;
    }
    const updateRect = () => {
      const shell = inputShellRef.current;
      if (!shell) return;
      const rect = shell.getBoundingClientRect();
      setAnchorRect({ top: rect.bottom, left: rect.left });
    };
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [menuOpen]);

  // Collapsing the sidebar would hide the input but leave the dropdown
  // orphaned with a stale anchor — close it preemptively.
  useEffect(() => {
    if (collapsed && menuOpen) setMenuOpen(false);
  }, [collapsed, menuOpen]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setValue(next);
      if (next.length > 0) setMenuOpen(true);
      else setMenuOpen(false);
    },
    [],
  );

  const handleFocus = useCallback(() => {
    if (hasValue) setMenuOpen(true);
  }, [hasValue]);

  const handleSelect = useCallback(
    (file: FormattedUserFile) => {
      // Mirror a drive-row click on a previewable file: open the
      // appropriate Video / Image / PDF dialog. The dialog mount logic
      // below filters by file type, so passing a non-previewable file
      // here is a no-op — we still close the menu so the click has
      // SOME feedback.
      setSelectedFile(file);
      setMenuOpen(false);
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

  if (collapsed) {
    return (
      <button
        type="button"
        aria-label="Search Files"
        onClick={() => {
          focusOnNextExpandRef.current = true;
          setSidebarCollapsed(false);
        }}
        className={cn(
          "flex items-center w-full rounded-[12px] bg-[#0000000F] p-[10px] text-[#1111114D] transition-colors overflow-hidden",
          "hover:bg-[#00000014] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#1111111A]",
          "dark:bg-[#0000000F] dark:text-white/30 dark:hover:bg-white/10 dark:focus-visible:ring-white/10",
        )}
      >
        <span className="size-[18px] flex-shrink-0 flex items-center justify-center">
          <Icons.Search className="size-[18px]" />
        </span>
      </button>
    );
  }

  return (
    <div ref={containerRef} className="w-full">
      <div
        ref={inputShellRef}
        // Keep the full shell clickable so the search field focuses.
        onClick={() => inputRef.current?.focus()}
        className={cn(
          "flex items-center gap-2 w-full rounded-[12px] bg-[#0000000F] px-3 py-2",
          "transition-colors focus-within:ring-1 focus-within:ring-inset focus-within:ring-[#1111111f] dark:bg-[#0000000F] dark:focus-within:ring-inset dark:focus-within:ring-white/10",
        )}
      >
        <span className="size-[18px] flex-shrink-0 flex items-center justify-center text-[#1111114D] dark:text-white/30">
          <Icons.Search className="size-[18px]" />
        </span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onFocus={handleFocus}
          placeholder="Search Files"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 outline-none text-[14px] leading-5 font-medium text-black placeholder:text-[#1111114D] dark:text-white dark:placeholder:text-white/30"
        />
        {hasValue ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setValue("");
              setMenuOpen(false);
              inputRef.current?.focus();
            }}
            className={cn(
              "flex items-center justify-center rounded-md px-1.5 py-0.5",
              "text-[#1111114D] transition-colors hover:text-[#11111180] dark:text-white/30 dark:hover:text-white/70",
            )}
          >
            <Icons.Close className="size-3.5" />
          </button>
        ) : (
          <span className="flex items-center gap-1 rounded-md text-[#1111114D] dark:text-white/30 px-1.5 py-0.5 text-[11px] font-medium">
            <Command className="size-3.5" strokeWidth={1.5} />
            <span>F</span>
          </span>
        )}
      </div>

      {menuOpen &&
        hasValue &&
        anchorRect &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[60]"
            style={{ top: anchorRect.top + 6, left: anchorRect.left }}
          >
            <SidebarSearchMenu
              files={results}
              isFetching={isFetching}
              searchTerm={value}
              onSelect={handleSelect}
            />
          </div>,
          document.body,
        )}

      {/* Preview dialogs mirror DriveContent's mount pattern. The drive
          view mounts one dialog per type and gates rendering on
          `selectedFileType`; we do the same here. The provider is
          required because `FileViewerLayout` (inside each dialog) calls
          `useFileSelection`, which throws when no provider is in scope.
          A local sidebar-scoped instance keeps selection state isolated
          from the drive page. */}
      {selectedFileType && (
        <FileSelectionProvider>
          {selectedFileType === "video" && (
            <VideoDialog
              file={selectedFile}
              allFiles={results}
              onCloseClicked={handleClosePreview}
              onNavigate={setSelectedFile}
              handleFileDownload={handleFileDownload}
            />
          )}
          {selectedFileType === "image" && (
            <ImageDialog
              file={selectedFile}
              allFiles={results}
              onCloseClicked={handleClosePreview}
              onNavigate={setSelectedFile}
              handleFileDownload={handleFileDownload}
            />
          )}
          {selectedFileType === "PDF" && (
            <PdfDialog
              file={selectedFile}
              allFiles={results}
              onCloseClicked={handleClosePreview}
              onNavigate={setSelectedFile}
              handleFileDownload={handleFileDownload}
            />
          )}
        </FileSelectionProvider>
      )}
    </div>
  );
};

export default SidebarSearch;
