import { FC } from "react";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import Link from "next/link";
import { FileTypes } from "@/lib/types/fileTypes";
import { formatDisplayName, getFileIcon } from "@/lib/utils/fileTypeUtils";
import { cn } from "@/lib/utils";

type NameCellProps = {
  rawName: string;
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
  cid,
  className,
  fileType,
  isPreviewable = false,
  isFolder = false,
}) => {
  const name = formatDisplayName(rawName);
  const { icon: Icon, color } = getFileIcon(fileType, isFolder);

  return (
    <div className={className}>
      {isFolder ? (
        <Link href={`/files?folderCid=${decodeHexCid(cid)}&folderName=${encodeURIComponent(name)}`}>
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
