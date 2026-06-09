import React, { useState, useEffect, useMemo } from "react";
import { isVersionGreaterOrEqual } from "@/lib/utils/versionCompare";
import { IconComponent } from "@/app/lib/types";
import { notificationCategoryLabel } from "@/app/lib/helpers/notificationCategories";
import { handleButtonLink } from "@/app/lib/utils/links";
import { ArrowUpCircle, ArrowDownCircle, Trash2, MoreVertical } from "lucide-react";
import TimeAgo from "react-timeago";
import NotificationContextMenu from "./NotificationContextMenu";
import { InView } from "react-intersection-observer";
import { useRouter } from "next/navigation";
import BasicMarkdown from "@/components/updater/BasicMarkdown";
import { getVersion } from "@tauri-apps/api/app";
import { cn, getFilePartsFromFileName, getFileTypeFromExtension } from "@/lib/utils";
import { getFileIcon, formatDisplayName } from "@/lib/utils/fileTypeUtils";
import { formatBytes } from "@/lib/utils/formatBytes";
import type { SyncedFileDetail } from "@/lib/hooks/useFilesNotification";
import { Button } from "@/components/ui/button";

export function parseFileDetails(type: string, releaseNotes: string): SyncedFileDetail[] {
  if (type !== "Files" || !releaseNotes) return [];
  try {
    const parsed = JSON.parse(releaseNotes);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON — fall through
  }
  return [];
}

const ICON_BG: Record<string, string> = {
  Subscription: "#fc7d73",
  Balance:      "#fc7d73",
  Credits:      "#fc7d73",
  Files:        "#3067dd",
  Hippius:      "#3067dd",
  Blockchain:   "#3067dd",
  Storage:      "#3067dd",
};

interface NotificationDetailViewProps {
  selectedNotification: {
    id?: number;
    icon: IconComponent;
    type: string;
    subType?: string;
    title: string;
    description: string;
    releaseNotes?: string;
    time: string | number;
    timestamp?: number;
    actionText?: string;
    actionLink?: string;
    unread?: boolean;
  } | null;
  onReadStatusChange?: (id: number, isUnread: boolean) => void;
}

const NotificationDetailView: React.FC<NotificationDetailViewProps> = ({
  selectedNotification,
  onReadStatusChange,
}) => {
  const router = useRouter();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");

  useEffect(() => {
    getVersion()
      .then(setCurrentVersion)
      .catch((err: unknown) =>
        console.warn("[NotificationDetailView] Failed to get app version:", err)
      );
  }, []);

  const fileSummary = useMemo(() => {
    if (!selectedNotification) return null;
    const releaseNotesText = selectedNotification.releaseNotes?.trim() ?? "";
    const fileDetails = parseFileDetails(selectedNotification.type, releaseNotesText);
    if (selectedNotification.type !== "Files" || fileDetails.length === 0) return null;
    const uploaded = fileDetails.filter((f) => f.action === "upload");
    const downloaded = fileDetails.filter((f) => f.action === "download");
    const deleted = fileDetails.filter(
      (f) => f.action === "local_delete" || f.action === "remote_delete"
    );
    return { uploaded, downloaded, deleted };
  }, [selectedNotification]);

  if (!selectedNotification) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <p className="text-[14px] font-medium text-grey-dark-500 dark:text-grey-dark-400">
          Select a notification to view details
        </p>
      </div>
    );
  }

  const {
    id,
    icon: Icon,
    type,
    subType,
    title,
    description,
    releaseNotes,
    time,
    timestamp,
    actionText,
    actionLink,
    unread = false,
  } = selectedNotification;

  const isUpdateNotification = type === "Hippius" && subType && actionLink === "Install Update";
  const isUpdateAlreadyInstalled =
    isUpdateNotification && currentVersion && isVersionGreaterOrEqual(currentVersion, subType);
  const shouldShowButton = actionText && !isUpdateAlreadyInstalled;

  const releaseNotesText = releaseNotes?.trim() ?? "";
  const hasReleaseNotes = releaseNotesText.length > 0;
  const fileDetails = parseFileDetails(type, releaseNotesText);
  const isFilesNotification = type === "Files" && fileDetails.length > 0;
  const hasRegularReleaseNotes = hasReleaseNotes && !isFilesNotification;
  const descriptionText = hasRegularReleaseNotes
    ? `${description}${description.endsWith(".") ? "" : "."} See what's new below.`
    : description;

  const iconBg = ICON_BG[type] ?? "#3067dd";

  const handleMoreClick = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({ x: rect.right, y: rect.bottom });
  };

  const handleReadStatusToggle = () => {
    if (id && onReadStatusChange) {
      onReadStatusChange(id, !unread);
    }
  };

  const handleLinkClick = (e: React.MouseEvent) => {
    handleButtonLink(e, actionLink, router);
  };

  return (
    <InView triggerOnce>
      {({ ref }) => (
        <div ref={ref} className="flex flex-col h-full overflow-y-auto">
          {/* Header */}
          <div className="flex items-start gap-3 px-3 py-3 border-b border-grey-dark-100 dark:border-black-300 flex-shrink-0">
            <div
              className="size-9 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden"
              style={{ backgroundColor: iconBg }}
            >
              <Icon className={cn("text-white", type === "Hippius" ? "size-6" : "size-5")} />
            </div>

            <div className="flex flex-col flex-1 min-w-0">
              <p className="text-[14px] font-medium truncate text-[#0a0a0a] dark:text-white">
                {notificationCategoryLabel(type)}
              </p>
              <p className="text-[13px] font-medium truncate text-[#0a0a0a] dark:text-grey-dark-700">
                {title}
              </p>
            </div>

            <span className="text-[13px] font-medium flex-shrink-0 text-[#0a0a0a] dark:text-grey-dark-400">
              {timestamp ? <TimeAgo date={timestamp} /> : time}
            </span>

            <button
              className="text-grey-dark-500 dark:text-grey-dark-400 hover:text-[#0a0a0a] dark:hover:text-white p-1 rounded transition-colors flex-shrink-0"
              onClick={handleMoreClick}
            >
              <MoreVertical className="size-4" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-[9px] flex flex-col gap-4 flex-1">
            <p className="text-[14px] font-medium leading-[20px] break-words text-[#0a0a0a] dark:text-grey-light-100">
              {descriptionText}
            </p>

            {/* File details */}
            {isFilesNotification && fileSummary && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  {fileSummary.uploaded.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#eef2ff] dark:bg-[#0d1a3d] border border-[#c7d7f8] dark:border-[#1e3a6e] rounded-full text-xs font-medium text-[#3067dd] dark:text-[#7aaeff]">
                      <ArrowUpCircle className="size-3.5" />
                      {fileSummary.uploaded.length} uploaded
                    </span>
                  )}
                  {fileSummary.downloaded.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#f0fdf4] dark:bg-[#0a2015] border border-[#bbf7d0] dark:border-[#155e32] rounded-full text-xs font-medium text-[#16a34a] dark:text-[#34d872]">
                      <ArrowDownCircle className="size-3.5" />
                      {fileSummary.downloaded.length} downloaded
                    </span>
                  )}
                  {fileSummary.deleted.length > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#fef2f2] dark:bg-[#2b100d] border border-[#fecaca] dark:border-[#6b1c18] rounded-full text-xs font-medium text-[#dc2626] dark:text-[#ff7d7d]">
                      <Trash2 className="size-3.5" />
                      {fileSummary.deleted.length} deleted
                    </span>
                  )}
                </div>

                <div className="max-h-[17.5rem] overflow-y-auto rounded-lg border border-grey-dark-100 dark:border-[#3a3a3a] divide-y divide-grey-dark-100 dark:divide-[#2e2e2e]">
                  {fileDetails.map((file, index) => {
                    const { fileFormat } = getFilePartsFromFileName(file.fileName);
                    const fileType = getFileTypeFromExtension(fileFormat || null);
                    const { icon: FileIcon, color } = getFileIcon(fileType ?? undefined, false);
                    const isDeleted = file.action === "local_delete" || file.action === "remote_delete";
                    const isUpload = file.action === "upload";
                    return (
                      <div
                        key={`${file.fileName}-${index}`}
                        className="flex items-center gap-3 px-3 py-2.5 bg-white dark:bg-[#1e1e1e] hover:bg-[#f8f8f8] dark:hover:bg-[#252525] transition-colors"
                      >
                        <div className="size-8 flex-shrink-0 flex items-center justify-center rounded-lg bg-[#f3f3f3] dark:bg-[#2a2a2a] border border-transparent dark:border-[#3a3a3a]">
                          <FileIcon className={cn("size-5", color)} />
                        </div>
                        <div className="flex flex-col justify-center min-w-0 flex-1">
                          <span className="text-[14px] font-medium truncate text-[#0a0a0a] dark:text-white" title={file.fileName}>
                            {formatDisplayName(file.fileName)}
                          </span>
                          {file.totalBytes > 0 && (
                            <span className="text-[12px] text-grey-dark-500 dark:text-grey-dark-600">
                              {formatBytes(file.totalBytes)}
                            </span>
                          )}
                        </div>
                        <div className="flex-shrink-0">
                          {isDeleted ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-[#fef2f2] dark:bg-[#2b100d] text-[#dc2626] dark:text-[#ff7d7d]">
                              <Trash2 className="size-3" /> Deleted
                            </span>
                          ) : isUpload ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-[#eef2ff] dark:bg-[#0d1a3d] text-[#3067dd] dark:text-[#7aaeff]">
                              <ArrowUpCircle className="size-3" /> Uploaded
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-[#f0fdf4] dark:bg-[#0a2015] text-[#16a34a] dark:text-[#34d872]">
                              <ArrowDownCircle className="size-3" /> Downloaded
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Release notes */}
            {hasRegularReleaseNotes && (
              <div className="max-h-[17.5rem] overflow-y-auto">
                <BasicMarkdown text={releaseNotesText} />
              </div>
            )}

            {/* Action buttons */}
            {shouldShowButton && (
              <div className="flex items-center gap-6 pt-2">
                <Button
                  variant="defaultStable"
                  size="auto"
                  className="px-[19px] py-2 text-[14px] font-medium tracking-[-0.28px]"
                  onClick={handleReadStatusToggle}
                >
                  {unread ? "Mark as read" : "Mark as unread"}
                </Button>
                <Button
                  variant="primary"
                  size="auto"
                  className="px-[19px] py-2 text-[14px] font-medium tracking-[-0.28px]"
                  onClick={handleLinkClick}
                >
                  {actionText}
                </Button>
              </div>
            )}

            {!shouldShowButton && id && (
              <div className="flex items-center gap-6 pt-2">
                <Button
                  variant="defaultStable"
                  size="auto"
                  className="px-[19px] py-2 text-[14px] font-medium tracking-[-0.28px]"
                  onClick={handleReadStatusToggle}
                >
                  {unread ? "Mark as read" : "Mark as unread"}
                </Button>
              </div>
            )}
          </div>

          {contextMenu && (
            <NotificationContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              isUnread={unread}
              onClose={() => setContextMenu(null)}
              onToggleReadStatus={handleReadStatusToggle}
              notificationId={id}
              onArchived={() => setContextMenu(null)}
              onArchiveStart={() => {}}
            />
          )}
        </div>
      )}
    </InView>
  );
};

export default NotificationDetailView;
