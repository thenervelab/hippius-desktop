import { FC } from "react";
import Link from "next/link";
import { FileTypes } from "@/lib/types/fileTypes";
import { getFileIcon } from "@/lib/utils/fileTypeUtils";
import { cn } from "@/lib/utils";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { buildFolderPath } from "@/app/utils/folderPathUtils";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";
import SyncFolderBadge from "@/components/ui/SyncFolderBadge";

type NameCellProps = {
  rawName: string;
  actualName?: string;
  arionHash: string;
  className?: string;
  isAssigned: boolean;
  fileType?: FileTypes;
  onShowDetails?: () => void;
  isPreviewable?: boolean;
  isFolder?: boolean;
  source?: string;
  mainReqHash?: string;
  syncStatus?: "synced" | "pending" | "unknown" | "excluded";
  label?: string;
  showFolderBadge?: boolean;
};

const SyncStatusBadge: FC<{ status?: "synced" | "pending" | "unknown" | "excluded" }> = ({ status }) => {
  if (status !== "pending") return null;
  return (
    <span
      className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-warning-95 text-warning-40 border border-warning-80 flex-shrink-0"
      title="Not yet uploaded — will sync automatically"
    >
      Pending upload
    </span>
  );
};

const NameCell: FC<NameCellProps> = ({
  rawName,
  actualName,
  arionHash,
  className,
  fileType,
  isPreviewable = false,
  isFolder = false,
  source,
  mainReqHash,
  syncStatus,
  label,
  showFolderBadge = false,
}) => {
  const { icon: Icon, color } = getFileIcon(fileType, isFolder);
  const { getParam } = useUrlParams();

  const mainFolderHash = getParam("mainFolderCid", "");
  const folderActualName = isFolder ? actualName || "" : "";
  const mainFolderActualName = getParam("mainFolderActualName", isFolder ? actualName || "" : "");
  const subFolderPath = getParam("subFolderPath", "");

  const effectiveMainFolderHash = mainFolderHash || arionHash;

  // Build the folder path for navigation
  const { mainFolderActualName: newMainFolder, subFolderPath: newSubFolderPath } = buildFolderPath(
    folderActualName,
    effectiveMainFolderHash,
    mainFolderActualName || folderActualName,
    subFolderPath
  );


  const folderUrl = {
    pathname: "/files",
    query: {
      mainFolderCid: effectiveMainFolderHash ?? "",
      folderCid: arionHash ?? "",
      folderName: rawName ?? "",
      folderActualName: actualName ?? "",
      mainFolderActualName: newMainFolder ?? "",
      subFolderPath: newSubFolderPath ?? "",
      folderSource: source || "",
      mainReqHash: mainReqHash
    },
  };


  return (
    <div className={cn("w-full min-w-0", className)} draggable={false}>
      {isFolder ? (
        <Link href={folderUrl} prefetch={false} draggable={false}>
          <div className="flex items-center min-w-0">
            <Icon className={cn("size-5 mr-2 flex-shrink-0", color)} />
            <MiddleTruncatedName
              name={rawName}
              className="text-grey-20 hover:text-primary-40 hover:underline transition"
            />
            {showFolderBadge && label && (
              <SyncFolderBadge label={label} className="ml-1.5" />
            )}
          </div>
        </Link>
      ) : (
        <div className="flex items-center min-w-0">
          <Icon className={cn("size-5 mr-2 flex-shrink-0", color)} />
          <MiddleTruncatedName
            name={rawName}
            className={cn(
              "text-grey-20",
              isPreviewable && "group-hover:text-primary-50 group-hover:underline"
            )}
          />
          <SyncStatusBadge status={syncStatus} />
          {showFolderBadge && label && (
            <SyncFolderBadge label={label} className="ml-1.5" />
          )}
        </div>
      )}
    </div>
  );
};

export default NameCell;
