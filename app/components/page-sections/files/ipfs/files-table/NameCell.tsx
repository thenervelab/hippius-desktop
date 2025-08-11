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
};

const NameCell: FC<NameCellProps> = ({
  rawName,
  actualName,
  cid,
  className,
  fileType,
  isPreviewable = false,
  isFolder = false,
}) => {
  const name = formatDisplayName(rawName);
  const { icon: Icon, color } = getFileIcon(fileType, isFolder);
  const { getParam } = useUrlParams();

  const folderCid = getParam("folderCid", "");
  const mainFolderCid = getParam("mainFolderCid", "");
  const folderActualName = isFolder ? actualName || "" : "";
  const mainFolderActualName = getParam("mainFolderActualName", isFolder ? actualName || "" : "");
  const subFolderPath = getParam("subFolderPath", "");

  // Build the folder path for navigation
  const { mainFolderCid: newMainFolderCID, mainFolderActualName: newMainFolder, subFolderPath: newSubFolderPath } = buildFolderPath(
    folderActualName,
    mainFolderCid || folderCid,
    mainFolderActualName || folderActualName,
    subFolderPath
  );


  return (
    <div className={className}>
      {isFolder ? (
        <Link href={`/files?folderCid=${decodeHexCid(cid)}&folderName=${encodeURIComponent(rawName)}&folderActualName=${encodeURIComponent(actualName ?? "")}&mainFolderCid=${encodeURIComponent(newMainFolderCID)}&mainFolderActualName=${encodeURIComponent(newMainFolder)}&subFolderPath=${encodeURIComponent(newSubFolderPath)}`}>
          <div className="flex items-center">
            <Icon className={cn("size-5 mr-2", color)} />
            <span className="text-grey-20 hover:text-primary-40 hover:underline transition">
              {name}
            </span>
          </div>
        </Link>
      ) : (
        <div className="flex items-center">
          <Icon className={cn("size-5 mr-2", color)} />
          <span className={cn(
            "text-grey-20",
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
