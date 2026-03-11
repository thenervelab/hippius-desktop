import React from "react";
import { FormattedTimestamp, Icons } from "@/components/ui";
import * as TableModule from "@/components/ui/alt-table";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { formatBytesFromBigInt } from "@/lib/utils/formatBytes";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getFileIcon } from "@/app/lib/utils/fileTypeUtils";
import { cn } from "@/app/lib/utils";
import { useIsPrivateView } from "@/app/lib/utils/viewUtils";

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
    <div className="text-base leading-[22px] font-medium text-grey-20">
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
  const isPrivateView = useIsPrivateView();

  // Get Arion Hash for display
  const arionHash = file ? file.arionHash : null;
  const isHashValid = arionHash && arionHash !== "pending";

  if (!file) return null;

  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);
  // arionHash is already defined above
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
      if (!arionHash) {
        console.error("No Arion Hash available");
        return;
      }
      await openUrl(`https://hipstats.com/file-tracker/${arionHash}`);
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
                : fileType
                  ? fileType.charAt(0).toUpperCase() + fileType.slice(1)
                  : ""}
            </div>
            {!isPrivateView && file.isErasureCoded && (
              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-white text-primary-60 border border-primary-50 shadow-sm">
                <Icons.ShieldSecurity className="size-3 mr-1.5 text-primary-50" />
                Erasure Coded
              </span>
            )}
          </div>
        </DetailRow>

        <DetailRow label="Date Uploaded">
          {file.createdAt === 0 ? "Unknown" : <FormattedTimestamp timestamp={file.createdAt} />}
        </DetailRow>

        <DetailRow label="File Size">
          <div className="flex items-center gap-2">
            <Icons.File className="size-4 text-grey-70" />
            <span>{fileSize}</span>
          </div>
        </DetailRow>

        <DetailRow label="Arion Hash" lastChild>
          {isHashValid ? (
            <>
              <TableModule.CopyableCell
                title="Copy Arion Hash"
                toastMessage="Arion Hash Copied Successfully!"
                copyAbleText={arionHash || ""}
                isTable={true}
                className="max-sm:[200px] max-w-[400px] h-full"
              />
              <div
                className="p-0 h-auto text-primary-50 text-base flex items-center gap-1 hover:underline cursor-pointer"
                onClick={handleViewOnExplorer}
              >
                View on File Tracker
                <Icons.SendSquare2 className="size-5 text-primary-50" />
              </div>
            </>
          ) : (
            <span className="text-grey-50">No Arion Hash available</span>
          )}
        </DetailRow>
      </div>
    </div>
  );
};

export default FileDetailsDialogContent;
