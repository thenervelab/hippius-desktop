import { FC } from "react";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import Link from "next/link";
import { FileTypes } from "@/lib/types/fileTypes";
import { formatDisplayName, getFileIcon } from "@/lib/utils/fileTypeUtils";
import { cn } from "@/lib/utils";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { buildFolderPath } from "@/app/utils/folderPathUtils";

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
  mainReqHash
}) => {
  const name = formatDisplayName(rawName);
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
            <span className="text-grey-20 hover:text-primary-40 hover:underline transition truncate">
              {name}
            </span>
          </div>
        </Link>
      ) : (
        <div className="flex items-center min-w-0">
          <Icon className={cn("size-5 mr-2 flex-shrink-0", color)} />
          <span className={cn(
            "text-grey-20 truncate",
            isPreviewable && "group-hover:text-primary-50 group-hover:underline"
          )}>
            {name}
          </span>
        </div>
      )}
    </div>
  );
};

export default NameCell;
