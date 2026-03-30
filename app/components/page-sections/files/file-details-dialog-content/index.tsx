import React from "react";
import { FormattedTimestamp, Icons } from "@/components/ui";
import * as TableModule from "@/components/ui/alt-table";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { formatBytesFromBigInt } from "@/lib/utils/formatBytes";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension, getFileTypeDisplayLabel } from "@/lib/utils/getTileTypeFromExtension";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { getFileIcon } from "@/app/lib/utils/fileTypeUtils";
import { cn } from "@/app/lib/utils";
import * as Tooltip from "@radix-ui/react-tooltip";
import { FolderOpen } from "lucide-react";

interface DetailRowProps {
  label: string;
  children: React.ReactNode;
  lastChild?: boolean;
}

const DetailRow: React.FC<DetailRowProps> = ({
  label,
  children,
  lastChild
}) => (
  <div
    className={cn("pb-4 border-b border-grey-80", { "border-b-0": lastChild })}
  >
    <div className="text-sm font-medium text-grey-70 mb-2">{label}</div>
    <div className="text-base leading-[1.375rem] font-medium text-grey-20 break-all">
      {children}
    </div>
  </div>
);

interface FileDetailsDialogContentProps {
  file?: FormattedUserFile;
}

const FileDetailsDialogContent: React.FC<FileDetailsDialogContentProps> = ({
  file
}) => {

  // Get Arion Hash for display
  const arionCid = file ? file.arionCid : null;
  const hasCid = arionCid && arionCid.length > 0;

  if (!file) return null;

  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);
  const { icon: Icon, color } = getFileIcon(
    fileType ?? undefined,
    !!file.isFolder
  );

  // Format file size
  const fileSize = file.size
    ? formatBytesFromBigInt(BigInt(file.size))
    : "Unknown";

  const handleViewOnExplorer = async () => {
    try {
      if (!arionCid) {
        console.error("No Arion Hash available");
        return;
      }
      await openUrl(`https://hipstats.com/file-tracker/${arionCid}`);
    } catch (error) {
      console.error("Failed to open Explorer:", error);
    }
  };

  return (
    <div className="flex justify-between flex-col gap-2 h-full">
      <div className="flex flex-col gap-3">
        <DetailRow label="File Name">{file.name}</DetailRow>

        <DetailRow label="File Type">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Icon className={cn("size-5", color)} />
              {file.isFolder
                ? "Folder"
                : getFileTypeDisplayLabel(fileType)}
            </div>

          </div>
        </DetailRow>

        <DetailRow label="Date Uploaded">
          {file.createdAt === 0 ? "—" : <FormattedTimestamp timestamp={file.createdAt} className="text-grey-20" />}
        </DetailRow>

        <DetailRow label="File Size" lastChild={!!file.isFolder && !file.label}>
          <div className="flex items-center gap-2">
            <Icons.File className="size-4 text-grey-70" />
            <span>{fileSize}</span>
          </div>
        </DetailRow>

        {file.label && (
          <DetailRow label="Sync Folder" lastChild={!!file.isFolder}>
            <span>{file.label}</span>
            <div
              className="mt-1 p-0 h-auto text-primary-50 text-sm flex items-center gap-1 hover:underline cursor-pointer w-fit"
              onClick={async () => {
                try {
                  let filePath = file.source;
                  if (!filePath && file.label) {
                    const fileName = file.actualFileName || file.name;
                    filePath = await invoke<string>("resolve_file_path", {
                      accountId: "",
                      label: file.label,
                      fileName,
                    });
                  }
                  if (filePath) {
                    // Derive the sync folder path by stripping the relative file portion
                    const relativeName = file.actualFileName || file.name;
                    const syncFolderPath = filePath.endsWith(relativeName)
                      ? filePath.slice(0, filePath.length - relativeName.length - 1)
                      : filePath;
                    await revealItemInDir(syncFolderPath);
                  } else {
                    toast.error("File is not available locally. It may only exist on another device.");
                  }
                } catch (error) {
                  console.error("Failed to reveal in Finder:", error);
                  toast.error("File is not available locally. It may only exist on another device.");
                }
              }}
            >
              <FolderOpen className="size-4" />
              <span>Reveal in Finder</span>
            </div>
          </DetailRow>
        )}

        {!file.isFolder && (
          <DetailRow label="Arion Hash" lastChild>
            {hasCid ? (
              <>
                <Tooltip.Provider delayDuration={200}>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <div>
                        <TableModule.CopyableCell
                          title="Copy Arion Hash"
                          toastMessage="Arion Hash Copied Successfully!"
                          copyAbleText={arionCid || ""}
                          isTable={true}
                          className="max-sm:max-w-[12.5rem] max-w-[25rem] h-full"
                        />
                      </div>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        className="z-50 max-w-[18.75rem] bg-white border border-grey-80 rounded-[0.5rem] px-3 py-2 text-xs font-medium text-grey-40 break-all shadow-lg"
                        side="top"
                        sideOffset={4}
                      >
                        {arionCid}
                        <Tooltip.Arrow className="fill-white" />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </Tooltip.Provider>
                <div
                  className="p-0 h-auto text-primary-50 text-base flex items-center gap-1 hover:underline cursor-pointer"
                  onClick={handleViewOnExplorer}
                >
                  View on File Tracker
                  <Icons.SendSquare2 className="size-5 text-primary-50" />
                </div>
              </>
            ) : (
              <span className="text-grey-50">Not yet synced</span>
            )}
          </DetailRow>
        )}
      </div>
    </div>
  );
};

export default FileDetailsDialogContent;
