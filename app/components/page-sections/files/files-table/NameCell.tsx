import { FC } from "react";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import Link from "next/link";
import { FileTypes } from "@/lib/types/fileTypes";
import { getFileIcon } from "@/lib/utils/fileTypeUtils";
import { cn } from "@/lib/utils";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { buildFolderPath } from "@/app/utils/folderPathUtils";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";

type NameCellProps = {
  rawName: string;
  actualName?: string;
  cid: string;
  className?: string;
  isAssigned: boolean;
  fileType?: FileTypes;
  onShowDetails?: () => void;
  isPreviewable?: boolean;
  isFolder?: boolean;
  source?: string;
  mainReqHash?: string;
  syncStatus?: "synced" | "pending" | "unknown";
};

const SyncStatusBadge: FC<{ status?: "synced" | "pending" | "unknown" }> = ({ status }) => {
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
  cid,
  className,
  fileType,
  isPreviewable = false,
  isFolder = false,
  source,
  mainReqHash,
  syncStatus,
}) => {
  const { icon: Icon, color } = getFileIcon(fileType, isFolder);
  const { getParam } = useUrlParams();

  const mainFolderCid = getParam("mainFolderCid", "");
  const folderActualName = isFolder ? actualName || "" : "";
  const mainFolderActualName = getParam("mainFolderActualName", isFolder ? actualName || "" : "");
  const subFolderPath = getParam("subFolderPath", "");

  const effectiveMainFolderCid = mainFolderCid || cid;

  // Build the folder path for navigation
  const { mainFolderActualName: newMainFolder, subFolderPath: newSubFolderPath } = buildFolderPath(
    folderActualName,
    effectiveMainFolderCid,
    mainFolderActualName || folderActualName,
    subFolderPath
  );


  const folderUrl = {
    pathname: "/files",
    query: {
      mainFolderCid: effectiveMainFolderCid ?? "",
      folderCid: decodeHexCid(cid) ?? "",
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
        </div>
      )}
    </div>
  );
};

export default NameCell;
