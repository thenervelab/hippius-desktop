"use client";

import React, {
  ReactNode,
  useEffect,
  useMemo,
  useCallback,
  useState,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAtomValue, useSetAtom } from "jotai";
import { Share2, Download, Trash2, X, ArrowLeft, ArrowRight } from "lucide-react";

import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { cn } from "@/app/lib/utils";
import {
  getNextViewableFile,
  getPrevViewableFile,
  getViewableFiles,
} from "@/app/lib/utils/mediaNavigation";
import {
  shareFeatureEnabledAtom,
  shareModalFileAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import { useFileSelection } from "@/app/contexts/FileSelectionContext";

import FileViewerThumbnailStrip from "./FileViewerThumbnailStrip";
import FileViewerTitle from "./FileViewerTitle";

interface FileViewerLayoutProps {
  file: FormattedUserFile;
  allFiles: FormattedUserFile[];
  onClose: () => void;
  onNavigate: (file: FormattedUserFile) => void;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
  /**
   * Optional direct delete handler. When provided (e.g. the sidebar search
   * preview, which has no drive-page selection bar), the trash button calls
   * this instead of entering selection mode. The drive page omits it and keeps
   * the selection-mode → action-bar flow.
   */
  onDelete?: (file: FormattedUserFile) => void;
  children: ReactNode;
}

const ActionButton: React.FC<{
  onClick: () => void;
  ariaLabel: string;
  children: ReactNode;
}> = ({ onClick, ariaLabel, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={ariaLabel}
    className={cn(
      "flex items-center justify-center p-2 rounded-[8px]",
      "border border-grey-dark-100 bg-white",
      "shadow-[0_1px_0_0_rgba(255,255,255,1),0_2px_5px_0_rgba(0,0,0,0.05)]",
      "text-grey-30 hover:text-grey-10 hover:bg-grey-light-700",
      "dark:border-black-300 dark:bg-black-primary-bg",
      "dark:shadow-[0_1px_0_0_rgba(0,0,0,1),0_2px_5px_0_rgba(0,0,0,0.05)]",
      "dark:text-grey-light-300 dark:hover:text-white dark:hover:bg-black-300",
      "transition-colors duration-150",
    )}
  >
    {children}
  </button>
);

const NavButton: React.FC<{
  onClick: () => void;
  ariaLabel: string;
  direction: "prev" | "next";
}> = ({ onClick, ariaLabel, direction }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={ariaLabel}
    className={cn(
      "size-[44px] flex items-center justify-center rounded-[11px]",
      "border-[1.4px] border-[#e4e4e7] bg-white",
      "shadow-[0_1px_0_0_rgba(255,255,255,1),0_2px_5px_0_rgba(0,0,0,0.05)]",
      "text-grey-30 hover:text-grey-10",
      "dark:border-black-300 dark:bg-black-primary-bg",
      "dark:shadow-[0_1px_0_0_rgba(0,0,0,1),0_2px_5px_0_rgba(0,0,0,0.05)]",
      "dark:text-grey-light-300 dark:hover:text-white",
      "transition-colors duration-150",
    )}
  >
    {direction === "prev" ? (
      <ArrowLeft className="size-[22px]" />
    ) : (
      <ArrowRight className="size-[22px]" />
    )}
  </button>
);

const FileViewerLayout: React.FC<FileViewerLayoutProps> = ({
  file,
  allFiles,
  onClose,
  onNavigate,
  handleFileDownload,
  onDelete,
  children,
}) => {
  const { polkadotAddress } = useWalletAuth();
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);
  const setShareModalFile = useSetAtom(shareModalFileAtom);
  const { enterSelectionModeAndSelectFile } = useFileSelection();

  const [isMac] = useState(() => {
    if (typeof navigator === "undefined") return false;
    const platform = (navigator.platform || "").toLowerCase();
    const ua = (navigator.userAgent || "").toLowerCase();
    return platform.includes("mac") || ua.includes("mac os");
  });

  // Include cloud-only files (uploaded from other devices / under server folders
  // not synced here) in BOTH the gallery strip and prev/next navigation. Their
  // thumbnails resolve through the Rust thumbnailer (the strip's `useThumbnail`)
  // and selecting one loads it in the main preview via `useViewableFileUrl`
  // (cache_remote_file). The old `localOnly: true` filtered them out, so server
  // files had no presence in the gallery at all.
  const navigationOptions = useMemo(() => ({ localOnly: false }), []);

  const viewableFiles = useMemo(
    () => getViewableFiles(allFiles, navigationOptions),
    [allFiles, navigationOptions],
  );

  const nextFile = useMemo(
    () => getNextViewableFile(file, allFiles, navigationOptions),
    [file, allFiles, navigationOptions],
  );

  const prevFile = useMemo(
    () => getPrevViewableFile(file, allFiles, navigationOptions),
    [file, allFiles, navigationOptions],
  );

  const handleNext = useCallback(() => {
    if (nextFile) onNavigate(nextFile);
  }, [nextFile, onNavigate]);

  const handlePrev = useCallback(() => {
    if (prevFile) onNavigate(prevFile);
  }, [prevFile, onNavigate]);

  const handleDownload = useCallback(() => {
    handleFileDownload(file, polkadotAddress ?? "");
  }, [handleFileDownload, file, polkadotAddress]);

  // Mirror the "Share via Link" table-row menu item: close the viewer
  // first so the share dialog isn't stacked over the full-screen
  // preview. ShareFileModal is mounted at the page root and reads the
  // atom, so setting it after onClose() opens it cleanly.
  const handleShare = useCallback(() => {
    onClose();
    setShareModalFile(file);
  }, [onClose, setShareModalFile, file]);

  const handleDelete = useCallback(() => {
    onClose();
    // A direct handler (sidebar search preview) deletes straight away via its
    // own confirm + `useDeleteFile`; the drive page falls back to selection
    // mode, where the bottom action bar drives the confirm + delete.
    if (onDelete) {
      onDelete(file);
    } else {
      enterSelectionModeAndSelectFile(file);
    }
  }, [onDelete, enterSelectionModeAndSelectFile, file, onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && nextFile) handleNext();
      else if (e.key === "ArrowLeft" && prevFile) handlePrev();
      else if (e.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nextFile, prevFile, handleNext, handlePrev, onClose]);

  // Prevent body and html scroll while open and snap to top so the
  // background image lines up with the page (matches the rest of the
  // protected layout, which is bg-fixed).
  useEffect(() => {
    const scrollY = window.scrollY;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    window.scrollTo(0, 0);
    return () => {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      window.scrollTo(0, scrollY);
    };
  }, []);

  // Share is gated on the same conditions as the table-row "Share via link"
  // menu item: server advertises support, file is not a folder, file is
  // fully synced. The viewer only opens for synced viewable files, so we
  // still defensively check syncStatus.
  // Sharing operates on the file's local synced path, so a cloud-only search
  // result (no local `source`) hides the action even though its status reads
  // "synced" — it isn't in a sync folder on this device.
  const canShare =
    shareEnabled &&
    !file.isFolder &&
    file.syncStatus === "synced" &&
    !!file.source;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-[999]",
            "data-[state=open]:animate-fade-in-0.3",
          )}
        >
          <Dialog.Content
            aria-describedby={undefined}
            className={cn(
              "fixed inset-0 flex flex-col overflow-hidden",
              "bg-cover bg-center bg-no-repeat",
              "bg-[url('/logged-in-app-background.png')]",
              "dark:bg-[url('/logged-in-app-background-dark.png')]",
            )}
          >
            {/* Frosted glass layer over the background image, matches the
                Figma's app-frame fill (light: white 70%, dark: #1e1e1e 75%). */}
            <div
              aria-hidden="true"
              className={cn(
                "absolute inset-0 backdrop-blur-[13px]",
                "bg-white/70 dark:bg-[#1e1e1e]/75",
              )}
            />

            {/* All visible content lives above the frosted layer */}
            <div className="relative z-10 flex flex-col h-full">
              {/* Top bar: filename on the left, action buttons on the right.
                  Outer header is drag-region so window dragging still works
                  from the empty band; individual buttons stop the drag via
                  pointer events. Left padding reserves space for the macOS
                  traffic-light controls. */}
              <header
                data-tauri-drag-region
                className="relative flex items-center justify-between w-full select-none shrink-0 h-[54px]"
              >
                <div
                  data-tauri-drag-region
                  className={cn(
                    "flex items-center select-none h-full shrink-0 min-w-0",
                    isMac ? "pl-[80px]" : "pl-[12px]",
                  )}
                >
                  <FileViewerTitle file={file} />
                </div>
                <div className="flex items-center gap-[13px] pr-[19px]">
                  {canShare && (
                    <ActionButton onClick={handleShare} ariaLabel="Share file">
                      <Share2 className="size-[17px]" strokeWidth={1.8} />
                    </ActionButton>
                  )}
                  <ActionButton
                    onClick={handleDownload}
                    ariaLabel="Download file"
                  >
                    <Download className="size-[17px]" strokeWidth={1.8} />
                  </ActionButton>
                  {file.isAssigned && (
                    <ActionButton onClick={handleDelete} ariaLabel="Delete file">
                      <Trash2 className="size-[17px]" strokeWidth={1.8} />
                    </ActionButton>
                  )}
                  <ActionButton onClick={onClose} ariaLabel="Close viewer">
                    <X className="size-[17px]" strokeWidth={1.8} />
                  </ActionButton>
                </div>
              </header>

              {/* sr-only title for Radix's a11y contract; the visible
                  filename in the top bar is not wrapped in Dialog.Title
                  so screen readers only announce it once. */}
              <Dialog.Title className="sr-only">{file.name}</Dialog.Title>

              {/* Preview area — laid out as side rails plus a flexible
                  media column. This keeps the media in normal flow so it
                  always ends 60px above the thumbnail strip, while
                  preserving the 40px gap from the side nav buttons and the
                  30px gap below the top actions. */}
              <div className="flex-1 min-h-0 px-[24px] pt-[34px] pb-[60px]">
                <div className="flex h-full min-h-0 items-stretch gap-x-[40px]">
                  <div className="flex w-[44px] shrink-0 items-center justify-center">
                    {prevFile ? (
                      <NavButton
                        onClick={handlePrev}
                        ariaLabel="Previous file"
                        direction="prev"
                      />
                    ) : (
                      <div aria-hidden="true" className="size-[44px] shrink-0" />
                    )}
                  </div>

                  <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
                    <div className="relative h-full w-full min-h-0 min-w-0 flex items-center justify-center">
                      {children}
                    </div>
                  </div>

                  <div className="flex w-[44px] shrink-0 items-center justify-center">
                    {nextFile ? (
                      <NavButton
                        onClick={handleNext}
                        ariaLabel="Next file"
                        direction="next"
                      />
                    ) : (
                      <div aria-hidden="true" className="size-[44px] shrink-0" />
                    )}
                  </div>
                </div>
              </div>

              {/* Thumbnail strip pinned to the bottom */}
              <FileViewerThumbnailStrip
                files={viewableFiles}
                currentFile={file}
                onSelect={onNavigate}
              />
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default FileViewerLayout;
