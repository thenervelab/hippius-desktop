import { FC } from "react";
import Link from "next/link";
import { FileTypes } from "@/lib/types/fileTypes";
import { getFileIcon } from "@/lib/utils/fileTypeUtils";
import { cn } from "@/lib/utils";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { buildFolderPath } from "@/app/utils/folderPathUtils";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";
import SharedLinkBadge from "@/components/page-sections/drive/SharedLinkBadge";
import * as Tooltip from "@radix-ui/react-tooltip";
import { ArrowUpFromLine, ArrowDownToLine } from "lucide-react";

type SyncStatusType =
  | "synced"
  | "pending"
  | "uploading"
  | "downloading"
  | "unknown"
  | "excluded";

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
  syncStatus?: SyncStatusType;
  /** Drive label for this file. Required for the per-file shared
   *  badge to look the file up in the shares index — the badge
   *  silently no-ops when missing, so old call sites keep working. */
  label?: string;
};

const SyncStatusIcon: FC<{ status?: SyncStatusType }> = ({ status }) => {
  if (status === "pending" || status === "uploading") {
    const label = status === "uploading" ? "Uploading" : "Pending upload";
    return (
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <ArrowUpFromLine
              className={cn(
                "ml-1.5 size-3.5 flex-shrink-0",
                status === "uploading"
                  ? "text-primary-50 animate-pulse"
                  : "text-warning-40",
              )}
            />
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="top"
              className="z-50 bg-white dark:bg-black-500 border border-grey-80 dark:border-black-300 rounded-[0.5rem] px-3 py-2 text-xs font-medium text-grey-40 dark:text-grey-light-200 shadow-lg"
              sideOffset={4}
            >
              {label}
              <Tooltip.Arrow className="fill-white dark:fill-black-500" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  }
  if (status === "downloading") {
    return (
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <ArrowDownToLine className="ml-1.5 size-3.5 flex-shrink-0 text-primary-50 animate-pulse" />
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="top"
              className="z-50 bg-white dark:bg-black-500 border border-grey-80 dark:border-black-300 rounded-[0.5rem] px-3 py-2 text-xs font-medium text-grey-40 dark:text-grey-light-200 shadow-lg"
              sideOffset={4}
            >
              Downloading
              <Tooltip.Arrow className="fill-white dark:fill-black-500" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  }
  return null;
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
}) => {
  const { icon: Icon, color } = getFileIcon(fileType, isFolder);
  const { getParam } = useUrlParams();

  const mainFolderHash = getParam("mainFolderCid", "");
  const folderActualName = isFolder ? actualName || "" : "";
  const mainFolderActualName = getParam(
    "mainFolderActualName",
    isFolder ? actualName || "" : "",
  );
  const subFolderPath = getParam("subFolderPath", "");

  const effectiveMainFolderHash = mainFolderHash || arionHash;

  // Build the folder path for navigation
  const {
    mainFolderActualName: newMainFolder,
    subFolderPath: newSubFolderPath,
  } = buildFolderPath(
    folderActualName,
    effectiveMainFolderHash,
    mainFolderActualName || folderActualName,
    subFolderPath,
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
      mainReqHash: mainReqHash,
    },
  };

  return (
    <div className={cn("w-full min-w-0", className)} draggable={false}>
      {isFolder ? (
        <Link
          href={folderUrl}
          prefetch={false}
          draggable={false}
          className="cursor-pointer"
        >
          <div className="flex items-center min-w-0">
            <Icon className={cn("size-5 mr-2 flex-shrink-0", color)} />
            <MiddleTruncatedName
              name={rawName}
              className="text-grey-20 dark:text-grey-light-100 transition"
              textClassName="hover:text-primary-40 hover:underline"
            />
          </div>
        </Link>
      ) : (
        <div className="flex items-center min-w-0">
          <Icon className={cn("size-5 mr-2 flex-shrink-0", color)} />
          <MiddleTruncatedName
            name={rawName}
            className="text-grey-20 dark:text-grey-light-100"
            textClassName={cn(
              isPreviewable &&
                "group-hover:text-primary-50 group-hover:underline cursor-pointer",
            )}
            suffix={
              <>
                <SyncStatusIcon status={syncStatus} />
                <SharedLinkBadge
                  label={label}
                  actualName={actualName}
                  isFolder={isFolder}
                  className="ml-1.5"
                />
              </>
            }
          />
        </div>
      )}
    </div>
  );
};

export default NameCell;
