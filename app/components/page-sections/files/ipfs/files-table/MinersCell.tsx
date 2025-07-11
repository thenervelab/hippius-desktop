import { FC } from "react";
import { InfoCircle } from "@/components/ui/icons";
import { getMinerIdFromBytes } from "@/lib/utils/getMinerIdFromBytes";
import { HIPPIUS_EXPLORER_CONFIG } from "@/lib/config";
import Link from "next/link";

type MinersCellProps = {
  isAssigned: boolean;
  minerIds: string[];
  fileDetails?: { filename: string; cid: string }[];
  onDelete?: () => void;
};

const MinersCell: FC<MinersCellProps> = ({
  isAssigned,
  fileDetails,
  minerIds,
}) => {
  if (!isAssigned) {
    const fileOrFolderText =
      fileDetails && fileDetails?.length > 1 ? "folder" : "file";
    return (
      <div className="relative inline-block group overflow-visible">
        <div className="bg-grey-90 border border-grey-80 px-2 py-1 max-w-[150px] rounded inline-flex items-center">
          <span className="text-xs font-medium text-grey-40">
            This {fileOrFolderText} is unpinned
          </span>
          <InfoCircle className="size-3 ml-1 text-grey-40" />
        </div>
        <div
          className="
          absolute bottom-full mb-2 left-1/2 transform -translate-x-1/2
          w-max max-w-[180px]
          bg-white border border-grey-80 rounded-[8px]
          px-2 py-2 text-xs font-medium text-grey-40 shadow-lg
          whitespace-normal break-words
          opacity-0 invisible group-hover:opacity-100 group-hover:visible
          transition-all duration-200 z-50
        "
        >
          Please wait a moment while {fileOrFolderText} is being pinned
          <div
            className="
            absolute bottom-[-6px] left-1/2 transform -translate-x-1/2
            w-0 h-0
            border-l-[6px] border-r-[6px] border-t-[6px]
            border-l-transparent border-r-transparent border-t-white
          "
          />
        </div>
      </div>
    );
  }

  if (!minerIds || !minerIds.length) {
    return <span className="text-grey-70 text-sm">No Miners</span>;
  }

  return (
    <div className="flex min-w-[200px] lg:flex-wrap gap-2">
      {minerIds.map((id) => {
        const short = getMinerIdFromBytes(id);
        return (
          <Link
            key={id}
            href={`${HIPPIUS_EXPLORER_CONFIG.baseUrl}/nodes/${short}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:opacity-80 transition-opacity"
            draggable={false}
          >
            <span className="text-success-20 font-medium text-xs px-2 py-1 rounded-full border border-success-60 bg-success-90"
              draggable={false}
            >
              {`${short.slice(0, 4)}...${short.slice(-4)}`}
            </span>
          </Link>
        );
      })}
    </div>
  );
};

export default MinersCell;
