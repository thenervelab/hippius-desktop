"use client";

import React, { useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useAtom } from "jotai";
import { X, FolderOpen, ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";

import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";
import { isCloudOnlyRow } from "@/app/lib/utils/cloudOnly";
import { useBreakpoint } from "@/app/lib/hooks";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { cn } from "@/app/lib/utils";
import { FormattedTimestamp, Icons } from "@/app/components/ui";
import * as TableModule from "@/app/components/ui/alt-table";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { formatBytesFromBigInt } from "@/lib/utils/formatBytes";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import {
  getFileTypeFromExtension,
  getFileTypeDisplayLabel,
} from "@/lib/utils/getTileTypeFromExtension";
import { getFileIcon } from "@/app/lib/utils/fileTypeUtils";
import { revealFile } from "@/lib/utils/revealFile";

const PANEL_WIDTH_PX = 305;

// One detail row — matches the Figma "Inner Content Right" pill:
//   wrapper:  bg-[#0000000F] (light) / bg-[#0000000F] (dark)
//             pl-[12px] pr-[10px] py-[10px] rounded-[12px]
//   stack:    flex-col, label on top with pb-[6px], value below
//   label:    Geist Mono 10px uppercase, opacity-40, tracking-[-0.2px]
//   value:    Geist 14px medium, leading-[20px], tracking-[-0.28px],
//             grey-dark-900 (light) / white (dark)
const PillRow: React.FC<{
  label: string;
  children: React.ReactNode;
}> = ({ label, children }) => (
  <div className="w-full flex items-center justify-center pl-[12px] pr-[10px] py-[10px] rounded-[12px] bg-[#0000000F] dark:bg-[#0000000F]">
    <div className="flex flex-1 min-w-0 flex-col items-start">
      <div className="flex items-center pb-[6px]">
        <p className="font-mono font-medium text-[10px] tracking-[-0.2px] uppercase  text-black-900/40 dark:text-white/40">
          {label}
        </p>
      </div>
      <div className="w-full font-geist text-[14px] leading-[20px] tracking-[-0.28px] font-medium text-grey-dark-900 dark:text-white">
        {children}
      </div>
    </div>
  </div>
);

interface PanelBodyProps {
  file: FormattedUserFile;
  onClose: () => void;
}

const PanelBody: React.FC<PanelBodyProps> = ({ file, onClose }) => {
  const { polkadotAddress } = useWalletAuth();
  const arionCid = file.arionCid ?? null;
  const hasCid = Boolean(arionCid && arionCid.length > 0);

  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);
  const { icon: TypeIcon, color } = getFileIcon(
    fileType ?? undefined,
    !!file.isFolder,
  );

  const fileSize = file.size
    ? formatBytesFromBigInt(BigInt(file.size))
    : "Unknown";

  const handleViewOnExplorer = async () => {
    try {
      if (!arionCid) return;
      await openUrl(`https://hipstats.com/file-tracker/${arionCid}`);
    } catch (err) {
      console.error("Failed to open Explorer:", err);
    }
  };

  return (
    // Figma outer: `flex-col items-center justify-between px-[12px]`. The
    // header is the first child of the top stack (gap-[8px]) — NOT a
    // separate row above it — and Arion Hash is the second flex child,
    // so justify-between pushes it to the bottom of the panel.
    <div className="flex h-full w-full flex-col items-center justify-between px-3">
      <div className="w-full flex flex-col gap-2 items-start">
        {/* Header row — sits inside the same px-[12px] outer with its own
            inner pad of px-[8px] py-[4px] per Figma. */}
        <div className="w-full flex items-center justify-between px-2 py-1 rounded-[12px]">
          <p className="font-medium text-[16px] leading-[20px] text-black-900 dark:text-white">
            {file.isFolder ? "Folder" : "File"} Details
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="size-[18px] rounded-md flex items-center justify-center bg-[#0000000F] dark:bg-[#FFFFFF0F] text-black-900/40 dark:text-grey-light-100/40 hover:text-black-900 dark:hover:text-white hover:bg-black/15 dark:hover:bg-white/25 transition-colors"
          >
            <X className="size-[10px]" strokeWidth={2.5} />
          </button>
        </div>

        <PillRow label="File Name">
          <p className="break-words">{file.name}</p>
        </PillRow>

        <PillRow label="File Type">
          <div className="flex items-center gap-[6px]">
            <span className="size-[20px] rounded-[4px] flex items-center justify-center shrink-0">
              <TypeIcon className={cn("size-5", color)} />
            </span>
            <span>
              {file.isFolder ? "Folder" : getFileTypeDisplayLabel(fileType)}
            </span>
          </div>
        </PillRow>

        <PillRow label="Date Uploaded">
          {file.createdAt === 0 ? (
            "—"
          ) : (
            <FormattedTimestamp
              timestamp={file.createdAt}
              className="text-grey-dark-900 dark:text-white"
            />
          )}
        </PillRow>

        <PillRow label="File Size">
          <div className="flex items-center gap-[6px]">
            <span className="size-[20px] rounded-[4px] flex items-center justify-center shrink-0">
              <Icons.File className="size-5 text-[#3167dd]" />
            </span>
            <span>{fileSize}</span>
          </div>
        </PillRow>

        {file.label && (
          <PillRow label="Sync Folder">
            <div className="break-words">{file.label}</div>
            {/* Nothing on disk to reveal for a cloud-only row (remote-drive
                browsing, cloud search hits, pending downloads) — hidden,
                matching the table/card/context-menu gating. */}
            {!isCloudOnlyRow(file) && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await revealFile({
                      sourcePath: file.source,
                      label: file.label,
                      accountId: polkadotAddress ?? undefined,
                      fileName: file.actualFileName || file.name,
                      revealFolder: true,
                    });
                  } catch (err) {
                    console.error("Failed to reveal in Finder:", err);
                    toast.error(
                      "File is not available locally. It may only exist on another device.",
                    );
                  }
                }}
                className="mt-[6px] flex items-center gap-[4px] text-[14px] font-medium text-[#3167dd] dark:text-[#618ce8] hover:underline cursor-pointer w-fit"
              >
                <FolderOpen className="size-4" />
                <span>Reveal in Finder</span>
              </button>
            )}
          </PillRow>
        )}
      </div>

      {!file.isFolder && (
        // Arion Hash bottom block — Figma: `flex-col items-start px-[8px] py-[18px] w-full`.
        // Label uses py-[6px] (its own pad), then a 6px gap to the value rows.
        <div className="w-full flex flex-col items-start px-2 py-[18px]">
          <div className="flex items-center justify-center py-[6px]">
            <p className="font-mono font-medium text-[10px] tracking-[-0.2px] uppercase opacity-40 text-black-900 dark:text-white">
              Arion Hash
            </p>
          </div>

          {hasCid ? (
            <div className="flex flex-col gap-[6px] w-full">
              <Tooltip.Provider delayDuration={200}>
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <div className="w-full">
                      <TableModule.CopyableCell
                        title="Copy Arion Hash"
                        toastMessage="Arion Hash Copied Successfully!"
                        copyAbleText={arionCid || ""}
                        isTable={true}
                        textColor="text-grey-20 dark:text-white"
                        className="max-w-full h-full"
                      />
                    </div>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      className="z-50 max-w-[18.75rem] bg-white dark:bg-black-600 border border-grey-80 dark:border-black-300 rounded-[0.5rem] px-3 py-2 text-xs font-medium text-grey-40 dark:text-grey-dark-600 break-all shadow-lg"
                      side="top"
                      sideOffset={4}
                    >
                      {arionCid}
                      <Tooltip.Arrow className="fill-white dark:fill-black-600" />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </Tooltip.Provider>

              <button
                type="button"
                onClick={handleViewOnExplorer}
                className="flex items-center gap-[4px] text-[14px] font-medium leading-none tracking-[-0.28px] text-[#3167dd] dark:text-[#618ce8] hover:underline w-fit"
              >
                <span>View on File Tracker</span>
                <ArrowUpRight className="size-3" strokeWidth={2.25} />
              </button>
            </div>
          ) : (
            <span className="text-[14px] text-grey-50 dark:text-white">
              Not yet synced
            </span>
          )}
        </div>
      )}
    </div>
  );
};

const FileDetailsPanel: React.FC = () => {
  const [file, setFile] = useAtom(fileDetailsPanelAtom);
  const isOpen = file !== null;
  const { isDesktop, isLargeDesktop } = useBreakpoint();

  const onClose = useCallback(() => {
    setFile(null);
  }, [setFile]);

  // Inline panel — animated width slide from `xl` up (xl AND 2xl). Sits as a
  // sibling of <main> (in ResponsiveContent) so it stays pinned to the
  // available screen height and never scrolls with page content. Below `xl`
  // it falls through to the slide-in overlay Dialog. `isDesktop` alone matched
  // only the `xl` range, so on large monitors (`2xl`) the panel wrongly
  // rendered as the overlay instead of inline.
  if (isDesktop || isLargeDesktop) {
    return (
      <AnimatePresence initial={false}>
        {isOpen && file && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: PANEL_WIDTH_PX, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="shrink-0 overflow-hidden h-full"
          >
            <div
              className="h-full overflow-y-auto"
              style={{ width: PANEL_WIDTH_PX }}
            >
              <PanelBody file={file} onClose={onClose} />
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    );
  }

  // Below 2xl — Radix Dialog with frosted overlay + slide-in from right.
  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[1002] bg-white/72 backdrop-blur-[5.75px] dark:bg-[rgba(4,4,4,0.4)] dark:backdrop-blur-[11.5px] animate-fade-in-0.2" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-0 right-0 bottom-0 w-full max-w-[305px] z-[1003] font-geist animate-panel-in overflow-y-auto pt-4 bg-cover bg-center bg-no-repeat bg-fixed bg-[url('/logged-in-app-background.png')] dark:bg-[url('/logged-in-app-background-dark.png')]"
        >
          <Dialog.Title className="sr-only">
            {file?.isFolder ? "Folder" : "File"} Details
          </Dialog.Title>
          {file && <PanelBody file={file} onClose={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default FileDetailsPanel;
