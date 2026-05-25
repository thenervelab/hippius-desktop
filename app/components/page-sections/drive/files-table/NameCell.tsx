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
import { ArrowUpFromLine, ArrowDownToLine, AlertCircle } from "lucide-react";

// Mirrors `FormattedUserFile.syncStatus`. `failed` is the FE-facing label for a
// snapshot file whose Rust-side `FileProgressStatus` is `Error` — e.g. an
// upload that hit HTTP 402 and won't be retried this cycle. We deliberately
// expose it as a separate status (rather than collapsing into `uploading`) so
// the icon, tooltip, and pulse semantics stay truthful.
type SyncStatusType =
  | "synced"
  | "pending"
  | "uploading"
  | "downloading"
  | "failed"
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
  /** Parent folder's path inside the sync drive (e.g.
   *  "MyDrive/Photos/2024"). Set by ExpandedFolderRows so that clicking
   *  a folder name in an inline-expanded subtree produces a URL that
   *  reflects the full path, not whatever the current URL still shows.
   *  When unset, the previous URL-driven behaviour is preserved. */
  parentSubFolderPath?: string;
};

const SyncStatusIcon: FC<{ status?: SyncStatusType }> = ({ status }) => {
  if (status === "pending" || status === "uploading") {
    const label = status === "uploading" ? "Uploading" : "Pending upload";
    // Distinct testids per state (not a shared `sync-status-upload`) so the
    // unit test for `pending` can't accidentally pass if the switch silently
    // routed `pending` through the `uploading` branch — they share an icon
    // glyph but mean different things (in-flight vs. queued).
    const testId =
      status === "uploading" ? "sync-status-uploading" : "sync-status-pending";
    return (
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <ArrowUpFromLine
              data-testid={testId}
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
            <ArrowDownToLine
              data-testid="sync-status-downloading"
              className="ml-1.5 size-3.5 flex-shrink-0 text-primary-50 animate-pulse"
            />
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
  if (status === "failed") {
    // No `animate-pulse` here: the pulse is reserved for in-flight states.
    // A static red icon signals a settled failure that won't resolve on its
    // own (typically 402 Payment Required — the user must top up credits).
    return (
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <AlertCircle
              data-testid="sync-status-failed"
              aria-label="Upload failed"
              className="ml-1.5 size-3.5 flex-shrink-0 text-error-70"
            />
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="top"
              className="z-50 bg-white border border-grey-80 rounded-[0.5rem] px-3 py-2 text-xs font-medium text-grey-40 shadow-lg"
              sideOffset={4}
            >
              Upload failed
              <Tooltip.Arrow className="fill-white" />
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
  parentSubFolderPath,
}) => {
  const { icon: Icon, color } = getFileIcon(fileType, isFolder);
  const { getParam } = useUrlParams();

  const mainFolderHash = getParam("mainFolderCid", "");
  const folderActualName = isFolder ? actualName || "" : "";
  // When the caller hands us a runtime-known parent path (inline-expanded
  // subtree), its first segment is the authoritative `mainFolderActualName`
  // and the whole string is the authoritative `subFolderPath`. Falling back
  // to URL params at this point would re-introduce the deep-click bug.
  const trimmedParentPath =
    parentSubFolderPath?.replace(/^\/+|\/+$/g, "") ?? "";
  const parentMainFolder = trimmedParentPath
    ? (trimmedParentPath.split("/")[0] ?? "")
    : "";
  const mainFolderActualName = trimmedParentPath
    ? parentMainFolder
    : getParam("mainFolderActualName", isFolder ? actualName || "" : "");
  const subFolderPath = trimmedParentPath
    ? trimmedParentPath
    : getParam("subFolderPath", "");

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
