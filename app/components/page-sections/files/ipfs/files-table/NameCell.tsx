import { FC } from "react";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import Link from "next/link";
import { FileTypes } from "@/lib/types/fileTypes";
import { formatDisplayName, getFileIcon, isDirectory } from "@/lib/utils/fileTypeUtils";
import { cn } from "@/lib/utils";

type NameCellProps = {
  rawName: string;
  cid: string;
  className?: string;
  isAssigned: boolean;
  fileType?: FileTypes;
  onShowDetails?: () => void;
  isPreviewable?: boolean;
};

const NameCell: FC<NameCellProps> = ({
  rawName,
  cid,
  className,
  fileType,
  isPreviewable = false,
}) => {
  const isDir = isDirectory(rawName);
  const name = formatDisplayName(rawName);
  const { icon: Icon, color } = getFileIcon(fileType, isDir);

  return (
    <div className={className}>
      {isDir ? (
        <Link href={`/dashboard/storage/ipfs/${decodeHexCid(cid)}`}>
          <div className="flex items-center">
            <Icon className={cn("size-5 mr-2", color)} />
            <span className="text-grey-20 hover:text-primary-40 transition">
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
